import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, customers, customerIdentifiers, identityConflicts, identityMergeEvents } from '@truvo/db';
import { IdentityGraphService } from './identity-graph.service';
import { closeRedis } from './identity.infra';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';

/**
 * Order 045 — real-Postgres proof (same skip-if-unreachable pattern as every prior
 * order's `*.tenant-isolation.test.ts`). Covers the acceptance criteria that only
 * mean something against real unique-constraint/FK/transaction behavior:
 * collision-safe namespacing, provider-neutral identity resolution (Shopify +
 * Klaviyo sharing a hashed identity), explicit conflict recording, idempotent
 * attach/merge, auditable merge evidence, and runtime-tested unmerge.
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
const WS_A = `test_ws_idg_a_${STAMP}`;
const WS_B = `test_ws_idg_b_${STAMP}`;

test('Identity Graph v2: collision-safety, provider-neutral resolution, conflicts, idempotent merge/unmerge, tenant isolation', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const svc = new IdentityGraphService(db, new CustomerContextService(db, suppression), suppression);
  const now = new Date();
  const emailHash = `email_${STAMP}`;

  try {
    // ── 1. Shopify + Klaviyo sharing the same approved hashed identity resolve to ONE customer ──
    const byEmail = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'truvo.identity', identifierType: 'email_hash',
      identifierValue: emailHash, sourceNamespace: 'checkout', observedAt: now,
    });
    assert.equal(byEmail.created, true);

    const shopify = await svc.attachIdentifier({
      workspaceId: WS_A, customerId: byEmail.customerId, providerNamespace: 'shopify',
      identifierType: 'external_id', identifierValue: `shop_cust_${STAMP}`, sourceNamespace: 'shopify', observedAt: now,
    });
    assert.equal(shopify.status, 'attached');

    const klaviyo = await svc.attachIdentifier({
      workspaceId: WS_A, customerId: byEmail.customerId, providerNamespace: 'klaviyo',
      identifierType: 'external_id', identifierValue: `klv_profile_${STAMP}`, sourceNamespace: 'klaviyo', observedAt: now,
    });
    assert.equal(klaviyo.status, 'attached');

    // Re-resolving by the SAME hashed email must land on the SAME customer (no duplicate person).
    const byEmailAgain = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'truvo.identity', identifierType: 'email_hash',
      identifierValue: emailHash, sourceNamespace: 'checkout', observedAt: now,
    });
    assert.equal(byEmailAgain.created, false);
    assert.equal(byEmailAgain.customerId, byEmail.customerId);

    const graph = await svc.getIdentityGraph(WS_A, byEmail.customerId);
    assert.ok(graph);
    const providers = graph!.identifiers.map((i) => i.providerNamespace).sort();
    assert.deepEqual(providers, ['klaviyo', 'shopify', 'truvo.identity']);

    // ── 2. Same external string from DIFFERENT providers must NOT collide ──
    const sharedString = `cust_${STAMP}`;
    const shopifyOwner = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'shopify', identifierType: 'external_id',
      identifierValue: sharedString, sourceNamespace: 'shopify', observedAt: now,
    });
    const hubspotOwner = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'hubspot', identifierType: 'external_id',
      identifierValue: sharedString, sourceNamespace: 'hubspot', observedAt: now,
    });
    assert.notEqual(shopifyOwner.customerId, hubspotOwner.customerId, 'mesma string, providers diferentes → pessoas diferentes');

    // ── 3. Conflicting strong identifiers remain separate + conflict recorded (no auto-merge) ──
    const otherCustomer = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'truvo.identity', identifierType: 'user_id',
      identifierValue: `user_${STAMP}`, sourceNamespace: 'auth', observedAt: now,
    });
    const attemptConflict = await svc.attachIdentifier({
      workspaceId: WS_A, customerId: otherCustomer.customerId, providerNamespace: 'truvo.identity',
      identifierType: 'email_hash', identifierValue: emailHash, sourceNamespace: 'checkout', observedAt: now,
    });
    assert.equal(attemptConflict.status, 'conflict');
    if (attemptConflict.status === 'conflict') {
      assert.equal(attemptConflict.existingCustomerId, byEmail.customerId);
    }
    const [conflictRow] = await db.select().from(identityConflicts).where(eq(identityConflicts.workspaceId, WS_A));
    assert.ok(conflictRow);
    assert.equal(conflictRow!.status, 'open');
    assert.equal(conflictRow!.existingCustomerId, byEmail.customerId);
    assert.equal(conflictRow!.incomingCustomerId, otherCustomer.customerId);
    // the two customers remain SEPARATE — no silent merge happened.
    const [emailOwnerRow] = await db.select().from(customers).where(eq(customers.id, byEmail.customerId));
    assert.notEqual(emailOwnerRow!.status, 'merged');

    // recordConflict re-detecting the SAME disagreement is idempotent (no duplicate row).
    const secondAttempt = await svc.attachIdentifier({
      workspaceId: WS_A, customerId: otherCustomer.customerId, providerNamespace: 'truvo.identity',
      identifierType: 'email_hash', identifierValue: emailHash, sourceNamespace: 'checkout', observedAt: now,
    });
    assert.equal(secondAttempt.status, 'conflict');
    const conflictRows = await db.select().from(identityConflicts).where(eq(identityConflicts.workspaceId, WS_A));
    assert.equal(conflictRows.length, 1, 'reportar a MESMA divergência de novo não deve criar uma segunda linha');

    // ── 4. Idempotent attach: re-attaching the SAME identifier to the SAME customer is a no-op ──
    const reattach = await svc.attachIdentifier({
      workspaceId: WS_A, customerId: byEmail.customerId, providerNamespace: 'shopify',
      identifierType: 'external_id', identifierValue: `shop_cust_${STAMP}`, sourceNamespace: 'shopify', observedAt: now,
    });
    assert.equal(reattach.status, 'already_attached');
    const shopifyRows = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.providerNamespace, 'shopify'));
    assert.equal(shopifyRows.filter((r) => r.workspaceId === WS_A && r.identifierValue === `shop_cust_${STAMP}`).length, 1);

    // ── 5. Deterministic merge: moves identifiers, marks source merged, records auditable evidence ──
    const mergeTarget = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'truvo.identity', identifierType: 'user_id',
      identifierValue: `merge_target_${STAMP}`, sourceNamespace: 'auth', observedAt: now,
    });
    const mergeSource = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'truvo.identity', identifierType: 'anonymous_id',
      identifierValue: `merge_source_${STAMP}`, sourceNamespace: 'pixel', observedAt: now,
    });

    const merge = await svc.mergeCustomers({
      workspaceId: WS_A, sourceCustomerId: mergeSource.customerId, targetCustomerId: mergeTarget.customerId,
      reason: 'deterministic_test_merge', sourceNamespace: 'test', actor: { type: 'system', label: 'order-045-test' },
    });
    assert.equal(merge.status, 'merged');
    assert.equal(merge.movedIdentifiers, 1);

    const [sourceAfterMerge] = await db.select().from(customers).where(eq(customers.id, mergeSource.customerId));
    assert.equal(sourceAfterMerge!.status, 'merged');
    assert.equal(sourceAfterMerge!.mergedIntoCustomerId, mergeTarget.customerId);

    const [mergedIdentifier] = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.identifierValue, `merge_source_${STAMP}`));
    assert.equal(mergedIdentifier!.customerId, mergeTarget.customerId, 'o identificador do perdedor deve apontar para o vencedor');

    const [mergeEvent] = await db.select().from(identityMergeEvents).where(
      eq(identityMergeEvents.id, merge.status === 'merged' ? merge.eventId : ''),
    );
    assert.ok(mergeEvent);
    assert.equal(mergeEvent!.operation, 'merge');
    assert.equal(mergeEvent!.sourceCustomerId, mergeSource.customerId);
    assert.equal(mergeEvent!.targetCustomerId, mergeTarget.customerId);
    assert.equal(mergeEvent!.evidence.movedIdentifiers.length, 1);
    assert.equal(mergeEvent!.evidence.movedIdentifiers[0]!.identifierValue, `merge_source_${STAMP}`);
    assert.equal(mergeEvent!.evidence.sourceStatusBeforeMerge, 'anonymous');

    // ── 6. Idempotent merge replay: repeating the exact same merge is a safe no-op ──
    const mergeReplay = await svc.mergeCustomers({
      workspaceId: WS_A, sourceCustomerId: mergeSource.customerId, targetCustomerId: mergeTarget.customerId,
      reason: 'deterministic_test_merge', sourceNamespace: 'test', actor: { type: 'system' },
    });
    assert.equal(mergeReplay.status, 'already_merged');
    assert.equal(mergeReplay.eventId, merge.status === 'merged' ? merge.eventId : null);
    const eventsAfterReplay = await db.select().from(identityMergeEvents).where(eq(identityMergeEvents.sourceCustomerId, mergeSource.customerId));
    assert.equal(eventsAfterReplay.length, 1, 'replay não deve criar um segundo evento de merge');

    // ── 7. Reversibility: unmerge restores the identifier + status, using ONLY the recorded evidence ──
    const unmergeEventId = merge.status === 'merged' ? merge.eventId : '';
    const unmerge = await svc.unmergeCustomers({
      workspaceId: WS_A, mergeEventId: unmergeEventId, reason: 'test_reversal', actor: { type: 'system' },
    });
    assert.equal(unmerge.status, 'unmerged');
    assert.equal(unmerge.restoredIdentifiers, 1);
    assert.equal(unmerge.skippedIdentifiers, 0);

    const [sourceAfterUnmerge] = await db.select().from(customers).where(eq(customers.id, mergeSource.customerId));
    assert.equal(sourceAfterUnmerge!.status, 'anonymous', 'status pré-merge restaurado a partir da evidência');
    assert.equal(sourceAfterUnmerge!.mergedIntoCustomerId, null);
    const [identifierAfterUnmerge] = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.identifierValue, `merge_source_${STAMP}`));
    assert.equal(identifierAfterUnmerge!.customerId, mergeSource.customerId, 'o identificador volta para o customer original');

    const [originalEventAfterUnmerge] = await db.select().from(identityMergeEvents).where(eq(identityMergeEvents.id, unmergeEventId));
    assert.equal(originalEventAfterUnmerge!.reversedByEventId, unmerge.status === 'unmerged' ? unmerge.eventId : null);

    // idempotent: unmerging the SAME event again is a safe no-op (returns the same reversal).
    const unmergeReplay = await svc.unmergeCustomers({
      workspaceId: WS_A, mergeEventId: unmergeEventId, reason: 'test_reversal', actor: { type: 'system' },
    });
    assert.equal(unmergeReplay.status, 'already_unmerged');
    const allEventsForSource = await db.select().from(identityMergeEvents).where(eq(identityMergeEvents.sourceCustomerId, mergeSource.customerId));
    assert.equal(allEventsForSource.length, 2, 'exatamente 1 merge + 1 unmerge — replay não duplica');

    // ── 8. Tenant isolation: the SAME (provider, type, value) in a DIFFERENT workspace is a DIFFERENT person ──
    const isolatedA = await svc.resolveOrCreateCustomer({
      workspaceId: WS_A, providerNamespace: 'shopify', identifierType: 'external_id',
      identifierValue: `isolation_${STAMP}`, sourceNamespace: 'shopify', observedAt: now,
    });
    const isolatedB = await svc.resolveOrCreateCustomer({
      workspaceId: WS_B, providerNamespace: 'shopify', identifierType: 'external_id',
      identifierValue: `isolation_${STAMP}`, sourceNamespace: 'shopify', observedAt: now,
    });
    assert.notEqual(isolatedA.customerId, isolatedB.customerId);
    assert.equal(isolatedA.created, true);
    assert.equal(isolatedB.created, true, 'workspace B não deve reaproveitar o customer de A pelo mesmo valor bruto');

    // cross-workspace merge must fail — target looked up under workspaceId=WS_A never finds a WS_B row.
    await assert.rejects(
      () => svc.mergeCustomers({
        workspaceId: WS_A, sourceCustomerId: isolatedA.customerId, targetCustomerId: isolatedB.customerId,
        reason: 'should_never_cross_workspace', sourceNamespace: 'test', actor: { type: 'system' },
      }),
      /not found in this workspace/,
    );
  } finally {
    for (const ws of [WS_A, WS_B]) {
      await db.delete(identityMergeEvents).where(eq(identityMergeEvents.workspaceId, ws)).catch(() => undefined);
      await db.delete(identityConflicts).where(eq(identityConflicts.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    // mergeCustomers triggers enqueueRetroactiveStitch → getRedis() (shared singleton,
    // identity.infra.ts). Even a successfully-connected idle client keeps the event
    // loop alive — same class of defect Order 040 found for the unreachable case,
    // here hit for the first time with Redis actually reachable.
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
