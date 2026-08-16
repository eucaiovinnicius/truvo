import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import { createDb, closeDb, customers, customerIdentifiers, identitySuppressions } from '@truvo/db';
import { CustomerContextService, LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { IdentityService } from '../identity/identity.service';
import { closeRedis } from '../identity/identity.infra';
import { IdentityGraphService, SuppressedIdentifierError } from '../identity/identity-graph.service';
import { CanonicalMappingService } from '../connectors/canonical-mapping';
import { CommerceWriteService } from '../connectors/commerce/commerce-write.service';
import { EventProjectionService } from '../customer-context/event-projection.service';

/**
 * Order 055 §3 — SUPPRESSION enforced at every write path the order names:
 * "event → canonical projection" (EventProjectionService + the v1 identify()
 * bridge, synchronizeLegacyIdentity), "identity attachment/resolution"
 * (IdentityGraphService), and "Connector Framework canonical mapping"
 * (CanonicalMappingService, which inherits IdentityGraphService's enforcement).
 * Plus: cross-workspace isolation and explicit reactivation.
 */
let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.DATABASE_URL;
  if (!url) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(url, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
  return reachable;
}

const STAMP = Date.now();
const WS_A = `test_ws_supp_a_${STAMP}`;
const WS_B = `test_ws_supp_b_${STAMP}`;

test('suppression is enforced at synchronizeLegacyIdentity, IdentityGraphService, CanonicalMappingService, and EventProjectionService', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identity = new IdentityService(db, customerContext, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, new CommerceWriteService(db, customerContext));
  const projection = new EventProjectionService(db);
  const now = new Date();

  const suppressedEmail = `email_supp_${STAMP}`;
  const liveAnon = `anon_supp_${STAMP}`;

  try {
    // ── 1. synchronizeLegacyIdentity (v1 bridge): a mix of one suppressed + one live ref ──
    await suppression.suppress(WS_A, { providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: suppressedEmail }, { reason: 'test' });

    await customerContext.synchronizeLegacyIdentity(WS_A, 'usr_mixed', [
      { identifier: suppressedEmail, type: 'email_hash' },
      { identifier: liveAnon, type: 'anonymous_id' },
    ], [], now);

    const mirroredEmail = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_A), eq(customerIdentifiers.identifierValue, suppressedEmail)));
    assert.equal(mirroredEmail.length, 0, 'o ref suprimido NÃO deve virar customer_identifiers');
    const mirroredAnon = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_A), eq(customerIdentifiers.identifierValue, liveAnon)));
    assert.equal(mirroredAnon.length, 1, 'o ref NÃO suprimido do mesmo lote continua sendo espelhado normalmente');

    // ── 2. identify() (v1): TODOS os refs suprimidos → rejeitado explicitamente ──
    await suppression.suppress(WS_A, { providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'anonymous_id', identifierValue: `only_suppressed_${STAMP}` }, { reason: 'test' });
    await assert.rejects(
      () => identity.identify(WS_A, { anonymous_id: `only_suppressed_${STAMP}` }),
      /suprimid/,
    );

    // ── 3. IdentityGraphService: attachIdentifier / resolveOrCreateCustomer fail closed ──
    const [target] = await db.insert(customers).values({ workspaceId: WS_A, id: `usr_target_${STAMP}`, status: 'identified', sourceNamespace: 'test', firstSeenAt: now, lastSeenAt: now }).returning();
    await suppression.suppress(WS_A, { providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}` }, { reason: 'test' });

    await assert.rejects(
      () => identityGraph.attachIdentifier({
        workspaceId: WS_A, customerId: target!.id, providerNamespace: 'v2test', identifierType: 'external_id',
        identifierValue: `ext_supp_${STAMP}`, sourceNamespace: 'test', observedAt: now,
      }),
      SuppressedIdentifierError,
    );
    await assert.rejects(
      () => identityGraph.resolveOrCreateCustomer({
        workspaceId: WS_A, providerNamespace: 'v2test', identifierType: 'external_id',
        identifierValue: `ext_supp_${STAMP}`, sourceNamespace: 'test', observedAt: now,
      }),
      SuppressedIdentifierError,
    );

    // ── 4. CanonicalMappingService: skips the suppressed record, applies the rest ──
    const applied = await mapping.apply(WS_A, `conn_test_${STAMP}`, 'test.connector', [
      { identifiers: [{ providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}` }], observedAt: now.toISOString() },
      { identifiers: [{ providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_live_${STAMP}` }], observedAt: now.toISOString() },
    ]);
    assert.equal(applied.suppressed, 1);
    assert.equal(applied.customersResolved, 1, 'só o record NÃO suprimido deve resolver um customer');

    // ── 5. EventProjectionService: refuses to write new data under a TOMBSTONED customer ──
    const deletedCustomerId = `usr_deleted_${STAMP}`;
    await db.insert(customers).values({ workspaceId: WS_A, id: deletedCustomerId, status: 'identified', sourceNamespace: 'test', firstSeenAt: now, lastSeenAt: now, deletedAt: now });
    const projResult = await projection.project(WS_A, deletedCustomerId, {
      event_id: `evt_${STAMP}`, event_name: 'purchase', order_id: `ord_${STAMP}`, properties: { value: 10, currency: 'BRL' },
    });
    assert.equal(projResult.projected, false);
    assert.equal(projResult.reason, 'customer_suppressed');

    // ── 6. cross-workspace isolation: the SAME identifier suppressed in A is NOT suppressed in B ──
    const isSuppressedInB = await suppression.isSuppressed(WS_B, { providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}` });
    assert.equal(isSuppressedInB, false);
    const attachInB = await identityGraph.attachIdentifier({
      workspaceId: WS_B,
      customerId: (await identityGraph.resolveOrCreateCustomer({ workspaceId: WS_B, providerNamespace: 'v2test', identifierType: 'user_id', identifierValue: `owner_${STAMP}`, sourceNamespace: 'test', observedAt: now })).customerId,
      providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}`, sourceNamespace: 'test', observedAt: now,
    });
    assert.equal(attachInB.status, 'attached', 'o mesmo identificador em outro workspace nunca deve ser afetado');

    // ── 7. explicit reactivation is distinguishable from accidental replay ──
    const reactivated = await suppression.reactivate(WS_A, { providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}` }, { actor: 'admin_user', reason: 'policy exception' });
    assert.equal(reactivated, true);
    const stillSuppressed = await suppression.isSuppressed(WS_A, { providerNamespace: 'v2test', identifierType: 'external_id', identifierValue: `ext_supp_${STAMP}` });
    assert.equal(stillSuppressed, false, 'após reativação explícita, o identificador não está mais suprimido');
    const [reactivatedRow] = await db.select().from(identitySuppressions).where(and(eq(identitySuppressions.workspaceId, WS_A), eq(identitySuppressions.identifierValue, `ext_supp_${STAMP}`)));
    assert.equal(reactivatedRow!.reactivatedBy, 'admin_user');
    assert.notEqual(reactivatedRow!.reactivatedAt, null, 'a reativação é seu PRÓPRIO registro auditável, não a mera ausência de linha');
  } finally {
    for (const ws of [WS_A, WS_B]) {
      await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
