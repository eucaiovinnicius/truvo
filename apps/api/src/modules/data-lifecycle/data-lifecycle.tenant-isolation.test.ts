import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, isNull } from 'drizzle-orm';
import {
  createDb, closeDb, customers, customerIdentifiers, customerTraits, customerOutcomes, dataLifecycleRequests,
  identityLinks, identityMerges, identityConflicts, identityMergeEvents, connectorConnections, integrations, integrationOutConfigs,
} from '@truvo/db';
import { DataLifecycleService } from './data-lifecycle.service';
import { closeClickHouse, getClickHouse } from './erasure/clickhouse.infra';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { AuditService } from '../audit/audit.service';

/**
 * Order 055 — DATA LIFECYCLE (real-Postgres + real-ClickHouse proof). Extends the
 * Order 035 workspace-deletion proof (batched subquery + tenant isolation) to the
 * stores Orders 40/45/50 added afterward, and re-proves subject deletion
 * idempotency against the NEW per-store result shape. Both `requestSubjectDeletion`
 * and `requestWorkspaceDeletion` now execute a ClickHouse mutation, so 'completed'
 * genuinely requires BOTH stores reachable — same skip-if-unreachable posture as
 * every prior order, checking two dependencies instead of one.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order055_lifecycle_test_key_dev_only';

let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const pgUrl = process.env.DATABASE_URL;
  if (!pgUrl) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(pgUrl, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
  } catch {
    reachable = false;
    await probe.end({ timeout: 1 }).catch(() => undefined);
    return reachable;
  }
  await probe.end({ timeout: 1 }).catch(() => undefined);

  try {
    await getClickHouse().query({ query: 'select 1', format: 'JSONEachRow' });
    reachable = true;
  } catch {
    reachable = false;
  }
  return reachable;
}

const STAMP = Date.now();
const WS_TARGET = `test_ws_lifecycle_${STAMP}`;
const WS_OTHER = `test_ws_lifecycle_other_${STAMP}`;

test('requestWorkspaceDeletion covers every current MVP store, retry-safely, without cross-workspace effects', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL/ClickHouse não alcançáveis neste ambiente — ver HANDOFF (Postgres/ClickHouse dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const svc = new DataLifecycleService(db, new CustomerContextService(db, suppression), new AuditService(db), suppression);
  const now = new Date();

  try {
    await db.insert(customers).values([
      { workspaceId: WS_TARGET, id: 'c1', status: 'anonymous', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now },
      { workspaceId: WS_TARGET, id: 'c2', status: 'anonymous', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now },
      { workspaceId: WS_OTHER, id: 'other1', status: 'anonymous', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(customerIdentifiers).values([
      { workspaceId: WS_TARGET, id: `cid1_${STAMP}`, customerId: 'c1', identifierType: 'external_id', providerNamespace: 'order055-test', identifierValue: 'v1', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(customerTraits).values([
      { workspaceId: WS_TARGET, id: `ctr1_${STAMP}`, customerId: 'c2', traitNamespace: 'probe', traitKey: 'k', valueType: 'string', value: 'v', sourceNamespace: 'order055-test', observedAt: now },
    ]);
    await db.insert(customerOutcomes).values([
      { workspaceId: WS_TARGET, id: `oco1_${STAMP}`, customerId: 'c1', outcomeDefinitionId: 'ocd_missing', outcomeNamespace: 'commerce', outcomeKey: 'purchase', dedupeKey: `ord_${STAMP}`, eventId: `evt_${STAMP}`, sourceNamespace: 'order055-test', observedAt: now },
    ]).catch(() => undefined); // FK to outcome_definitions — best-effort seed, not the point of this test.
    await db.insert(identityLinks).values([
      { id: `idl1_${STAMP}`, workspaceId: WS_TARGET, identifier: `anon_${STAMP}`, identifierType: 'anonymous_id', canonicalId: 'c1', firstSeen: now },
    ]);
    await db.insert(connectorConnections).values([
      { workspaceId: WS_TARGET, id: `conn1_${STAMP}`, provider: 'fake_provider', role: 'source', displayName: 'test' },
    ]);
    await db.insert(integrations).values([
      { id: `int1_${STAMP}`, workspaceId: WS_TARGET, type: 'shopify', name: 'test', credentialsEncrypted: 'v1.aa.bb.cc' },
    ]);

    const first = await svc.requestWorkspaceDeletion(WS_TARGET, { id: 'user_owner', email: 'owner@ws.com' });
    assert.equal(first.status, 'completed', JSON.stringify(first.stores));
    assert.equal(first.counts.customers, 2);
    assert.equal(first.counts.identifiers, 1);
    assert.equal(first.counts.traits, 1);
    assert.equal(first.stores.identity_v1_ws?.status, 'completed');
    assert.equal(first.stores.connectors_ws?.status, 'completed');
    assert.equal(first.stores.integrations_ws?.status, 'completed');
    assert.equal(first.stores.clickhouse_ws?.status, 'completed');

    const remainingTarget = await db.select().from(customers).where(eq(customers.workspaceId, WS_TARGET));
    assert.ok(remainingTarget.every((c) => c.deletedAt !== null), 'todas as linhas do workspace-alvo devem estar tombstoned');

    const otherRows = await db.select().from(customers).where(eq(customers.workspaceId, WS_OTHER));
    assert.equal(otherRows.length, 1);
    assert.equal(otherRows[0]!.deletedAt, null, 'workspace B NUNCA deve ser afetado pelo tombstone de A');

    // hard-deleted stores: gone entirely, not tombstoned.
    assert.equal((await db.select().from(identityLinks).where(eq(identityLinks.workspaceId, WS_TARGET))).length, 0);
    assert.equal((await db.select().from(connectorConnections).where(eq(connectorConnections.workspaceId, WS_TARGET))).length, 0);
    assert.equal((await db.select().from(integrations).where(eq(integrations.workspaceId, WS_TARGET))).length, 0);

    const request = await svc.getRequest(WS_TARGET, first.requestId);
    assert.equal(request?.status, 'completed');
    assert.equal(request?.kind, 'workspace_deletion');

    // ── retry: everything already gone → zero rows re-processed, still 'completed' ──
    const second = await svc.requestWorkspaceDeletion(WS_TARGET, { id: 'user_owner' });
    assert.equal(second.status, 'completed');
    assert.equal(second.counts.customers, 0);
    assert.equal(second.counts.identifiers, 0);
    assert.equal(second.counts.traits, 0);
  } finally {
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_OTHER)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(identityLinks).where(eq(identityLinks.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(identityMerges).where(eq(identityMerges.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(identityConflicts).where(eq(identityConflicts.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(identityMergeEvents).where(eq(identityMergeEvents.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(integrations).where(eq(integrations.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(integrationOutConfigs).where(eq(integrationOutConfigs.workspaceId, WS_TARGET)).catch(() => undefined);
    await closeClickHouse().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});

test('requestSubjectDeletion is idempotent (isNull guard) and workspace-scoped', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL/ClickHouse não alcançáveis neste ambiente — ver HANDOFF (Postgres/ClickHouse dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const svc = new DataLifecycleService(db, new CustomerContextService(db, suppression), new AuditService(db), suppression);
  const now = new Date();
  const ws = `test_ws_subject_${STAMP}`;

  try {
    await db.insert(customers).values({ workspaceId: ws, id: 'subject1', status: 'anonymous', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now });

    const first = await svc.requestSubjectDeletion(ws, 'subject1', { id: 'user_owner' });
    assert.equal(first.status, 'completed', JSON.stringify(first.stores));
    assert.equal(first.stores.customer_context?.status, 'completed');
    assert.equal(first.stores.customer_context?.processedCount, 1);

    const second = await svc.requestSubjectDeletion(ws, 'subject1', { id: 'user_owner' });
    assert.equal(second.status, 'completed');
    assert.equal(second.stores.customer_context?.processedCount, 0, 'reexecutar sobre um titular já tombstoned não deve reprocessar');

    const rows = await db.select().from(customers).where(eq(customers.workspaceId, ws));
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.deletedAt, null);
    assert.equal((await db.select().from(customers).where(isNull(customers.deletedAt))).some((c) => c.workspaceId === ws), false);
  } finally {
    await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, ws)).catch(() => undefined);
    await closeClickHouse().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
