import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, customers, customerIdentifiers, identityConflicts, identityLinks, identityMerges } from '@truvo/db';
import { IdentityGraphService } from './identity-graph.service';
import { CustomerContextService, LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';

/**
 * Order 045 — "Critical migration rule": v1 `identity_links`/`identity_merges` data
 * must reconcile into v2 (`customers`/`customer_identifiers`) NON-DESTRUCTIVELY,
 * with a collision preflight that fails closed per-canonical rather than crashing
 * the whole sweep or silently overwriting a v2 owner that got there first.
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
const WS_CLEAN = `test_ws_backfill_clean_${STAMP}`;
const WS_COLLIDE = `test_ws_backfill_collide_${STAMP}`;

test('backfillLegacyIdentity: reconciles pre-existing v1 data non-destructively, fails closed on collision', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const svc = new IdentityGraphService(db, new CustomerContextService(db));
  const now = new Date();
  const canonicalWinner = `usr_bf_${STAMP}`;
  const canonicalLoser = `anon_bf_${STAMP}`;

  try {
    // ── setup: v1 data as if it predates this order (never touched by a live identify() call) ──
    await db.insert(identityLinks).values([
      { id: `idl_a_${STAMP}`, workspaceId: WS_CLEAN, identifier: `anon_${STAMP}`, identifierType: 'anonymous_id', canonicalId: canonicalWinner, firstSeen: now },
      { id: `idl_b_${STAMP}`, workspaceId: WS_CLEAN, identifier: `user_${STAMP}`, identifierType: 'user_id', canonicalId: canonicalWinner, firstSeen: now },
    ]);
    await db.insert(identityMerges).values([
      { id: `mrg_${STAMP}`, workspaceId: WS_CLEAN, canonicalId: canonicalWinner, mergedFrom: canonicalLoser, reason: 'stitch:test', at: now },
    ]);

    const result = await svc.backfillLegacyIdentity(WS_CLEAN);
    assert.equal(result.canonicalsProcessed, 1, 'só o canonical VENCEDOR aparece em identity_links (o perdedor já foi repontado)');
    assert.equal(result.canonicalsReconciled, 1);
    assert.equal(result.canonicalsSkippedForCollision, 0);
    assert.equal(result.collisions.length, 0);

    const [winnerCustomer] = await db.select().from(customers).where(eq(customers.id, canonicalWinner));
    assert.ok(winnerCustomer, 'customer v2 do vencedor deve existir após o backfill');
    assert.equal(winnerCustomer!.status, 'identified', 'tem user_id → identified');

    const [loserCustomer] = await db.select().from(customers).where(eq(customers.id, canonicalLoser));
    assert.ok(loserCustomer, 'customer v2 do PERDEDOR histórico também deve existir (via synchronizeLegacyIdentity)');
    assert.equal(loserCustomer!.status, 'merged');
    assert.equal(loserCustomer!.mergedIntoCustomerId, canonicalWinner);

    const mirroredIdentifiers = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS_CLEAN));
    const values = mirroredIdentifiers.map((r) => r.identifierValue).sort();
    assert.deepEqual(values, [`anon_${STAMP}`, `user_${STAMP}`].sort());
    assert.ok(mirroredIdentifiers.every((r) => r.customerId === canonicalWinner));
    assert.ok(mirroredIdentifiers.every((r) => r.providerNamespace === LEGACY_IDENTITY_NAMESPACE));

    // ── re-running the sweep is safe/idempotent (resumable) — no duplicate rows, same result ──
    const secondRun = await svc.backfillLegacyIdentity(WS_CLEAN);
    assert.equal(secondRun.canonicalsReconciled, 1);
    const identifiersAfterSecondRun = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS_CLEAN));
    assert.equal(identifiersAfterSecondRun.length, 2, 'reexecutar o sweep não deve duplicar linhas');

    // ── collision case: a v2-native owner got there FIRST under the same legacy key ──
    const preExisting = await svc.resolveOrCreateCustomer({
      workspaceId: WS_COLLIDE, providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash',
      identifierValue: `collide_${STAMP}`, sourceNamespace: 'test', observedAt: now,
    });
    const collidingCanonical = `usr_collide_${STAMP}`;
    await db.insert(identityLinks).values([
      { id: `idl_collide_${STAMP}`, workspaceId: WS_COLLIDE, identifier: `collide_${STAMP}`, identifierType: 'email_hash', canonicalId: collidingCanonical, firstSeen: now },
    ]);

    const collideResult = await svc.backfillLegacyIdentity(WS_COLLIDE);
    assert.equal(collideResult.canonicalsProcessed, 1);
    assert.equal(collideResult.canonicalsReconciled, 0, 'fail closed: o canonical em conflito NÃO é migrado');
    assert.equal(collideResult.canonicalsSkippedForCollision, 1);
    assert.equal(collideResult.collisions[0]!.conflictingOwnerId, preExisting.customerId);

    // non-destructive: the pre-existing v2 owner is untouched, and NO customer was
    // created for the colliding v1 canonical (nothing corrupted or overwritten).
    const [preExistingAfter] = await db.select().from(customerIdentifiers).where(
      eq(customerIdentifiers.identifierValue, `collide_${STAMP}`),
    );
    assert.equal(preExistingAfter!.customerId, preExisting.customerId);
    const [collidingCustomerRow] = await db.select().from(customers).where(eq(customers.id, collidingCanonical));
    assert.equal(collidingCustomerRow, undefined, 'nenhum customer deve ter sido criado para o canonical que colidiu');

    const [conflictRow] = await db.select().from(identityConflicts).where(eq(identityConflicts.workspaceId, WS_COLLIDE));
    assert.ok(conflictRow, 'a colisão deve ficar registrada e observável, não apenas descartada');
    assert.equal(conflictRow!.reason, 'legacy_backfill_collision');
  } finally {
    for (const ws of [WS_CLEAN, WS_COLLIDE]) {
      await db.delete(identityConflicts).where(eq(identityConflicts.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
      await db.delete(identityMerges).where(eq(identityMerges.workspaceId, ws)).catch(() => undefined);
      await db.delete(identityLinks).where(eq(identityLinks.workspaceId, ws)).catch(() => undefined);
    }
    await closeDb(db).catch(() => undefined);
  }
});
