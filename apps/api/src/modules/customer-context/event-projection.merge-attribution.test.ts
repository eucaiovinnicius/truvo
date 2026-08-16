import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { createDb, closeDb, customers, customerOutcomes, outcomeDefinitions, customerIdentifiers } from '@truvo/db';
import { CustomerContextService } from './customer-context.service';
import { SuppressionService } from './suppression.service';
import { EventProjectionService } from './event-projection.service';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { closeRedis } from '../identity/identity.infra';

/**
 * ORDER_040_OUTCOME_MERGE_ATTRIBUTION_CLOSURE — the raw/event-pipeline mirror of
 * Order 060's Shopify commerce-path merge proof: a purchase outcome projected for
 * canonical customer A must converge onto the surviving customer B after a REAL
 * `IdentityGraphService.mergeCustomers(A→B)`, when the SAME economic event is
 * reprocessed under current identity resolution — no duplicate row, no client-
 * trusted customer id, immutable economic fields (value/currency/dedupeKey)
 * untouched.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order040_merge_attribution_closure_test_key_dev_only';

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
const WS = `test_ws_evtproj_merge_${STAMP}`;
const WS_OTHER = `test_ws_evtproj_merge_other_${STAMP}`;

test('EventProjectionService: purchase outcome attribution converges through a real IdentityGraphService merge', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const projection = new EventProjectionService(db);

  const identity1Value = `merge_close_id1_${STAMP}`;
  const identity2Value = `merge_close_id2_${STAMP}`;
  const purchaseEvent = {
    event_id: `evt_merge_close_${STAMP}`,
    event_name: 'purchase',
    order_id: `ord_merge_close_${STAMP}`,
    timestamp: new Date('2026-08-01T00:00:00Z').toISOString(),
    properties: { value: 249.9, currency: 'BRL' },
  };

  try {
    // 1. create/resolve customer A.
    const resolvedA = await identityGraph.resolveOrCreateCustomer({
      workspaceId: WS,
      providerNamespace: 'test.merge_attribution',
      identifierType: 'external_id',
      identifierValue: identity1Value,
      sourceNamespace: 'test.merge_attribution',
      observedAt: new Date(),
    });
    const customerA = resolvedA.customerId;

    // 2. project a purchase event/order — assert exactly one outcome row belongs to A.
    const first = await projection.project(WS, customerA, purchaseEvent);
    assert.equal(first.projected, true);
    assert.equal(first.deduped, false);

    const rowsUnderA = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, purchaseEvent.order_id)));
    assert.equal(rowsUnderA.length, 1);
    assert.equal(rowsUnderA[0]!.customerId, customerA);

    // 3. create/resolve a SEPARATE customer B.
    const resolvedB = await identityGraph.resolveOrCreateCustomer({
      workspaceId: WS,
      providerNamespace: 'test.merge_attribution',
      identifierType: 'external_id',
      identifierValue: identity2Value,
      sourceNamespace: 'test.merge_attribution',
      observedAt: new Date(),
    });
    const customerB = resolvedB.customerId;
    assert.notEqual(customerA, customerB);

    // 4. real Order 45 merge: A → B. Never editing customer ids directly.
    const mergeResult = await identityGraph.mergeCustomers({
      workspaceId: WS,
      sourceCustomerId: customerA,
      targetCustomerId: customerB,
      reason: 'order040 outcome merge attribution closure test',
      sourceNamespace: 'test.merge_attribution',
      actor: { type: 'system', id: 'order040-test' },
    });
    assert.equal(mergeResult.status, 'merged');

    // 5. replay/reprocess the SAME purchase event under CURRENT identity resolution
    //    (identity1's identifier now resolves to B — Identity Graph v2's own
    //    guarantee, the SAME re-resolution a real consumer replay would perform).
    const reResolved = await identityGraph.resolveOrCreateCustomer({
      workspaceId: WS,
      providerNamespace: 'test.merge_attribution',
      identifierType: 'external_id',
      identifierValue: identity1Value,
      sourceNamespace: 'test.merge_attribution',
      observedAt: new Date(),
    });
    assert.equal(reResolved.customerId, customerB, 'identity1 must resolve to the surviving customer B after the merge');

    const replayed = await projection.project(WS, reResolved.customerId, purchaseEvent);
    assert.equal(replayed.projected, true);

    // 6. exactly one outcome still exists for the same natural key.
    const rowsAfterMerge = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, purchaseEvent.order_id)));
    assert.equal(rowsAfterMerge.length, 1, 'merge + replay must never create a second outcome row for the same economic order');

    // 7. that outcome now belongs to B.
    assert.equal(rowsAfterMerge[0]!.customerId, customerB, 'the outcome must have converged onto B, not stayed pinned to the merged-away A');
    assert.equal(rowsAfterMerge[0]!.id, first.outcomeId, 'same deterministic outcome id — no new row, only attribution advanced');

    // 8. value, currency and original outcome/economic identity remain unchanged.
    assert.equal(rowsAfterMerge[0]!.value, '249.9');
    assert.equal(rowsAfterMerge[0]!.currency, 'BRL');
    assert.equal(rowsAfterMerge[0]!.dedupeKey, purchaseEvent.order_id);
    assert.equal(rowsAfterMerge[0]!.eventId, purchaseEvent.event_id);
    assert.equal(rowsAfterMerge[0]!.observedAt.toISOString(), new Date(purchaseEvent.timestamp).toISOString());

    const [customerARow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, customerA)));
    assert.equal(customerARow!.status, 'merged');
    assert.equal(customerARow!.mergedIntoCustomerId, customerB);

    // 9. another replay is idempotent.
    const secondReplay = await projection.project(WS, customerB, purchaseEvent);
    assert.equal(secondReplay.deduped, true);
    const rowsAfterSecondReplay = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, purchaseEvent.order_id)));
    assert.equal(rowsAfterSecondReplay.length, 1);
    assert.equal(rowsAfterSecondReplay[0]!.customerId, customerB);

    // definition catalog written exactly once (idempotent onConflictDoNothing, untouched by this fix).
    const definitions = await db.select().from(outcomeDefinitions).where(and(eq(outcomeDefinitions.workspaceId, WS), eq(outcomeDefinitions.outcomeKey, 'purchase')));
    assert.equal(definitions.length, 1);

    // 10. identical event/order identifiers in ANOTHER workspace remain isolated.
    const resolvedOther = await identityGraph.resolveOrCreateCustomer({
      workspaceId: WS_OTHER,
      providerNamespace: 'test.merge_attribution',
      identifierType: 'external_id',
      identifierValue: identity1Value,
      sourceNamespace: 'test.merge_attribution',
      observedAt: new Date(),
    });
    const otherProjection = await projection.project(WS_OTHER, resolvedOther.customerId, purchaseEvent);
    assert.equal(otherProjection.deduped, false, 'a different workspace must never collide with WS\'s dedupe/merge state');

    const wsRowsOnly = await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS));
    assert.ok(wsRowsOnly.every((r) => r.workspaceId === WS));
    assert.equal(wsRowsOnly.length, 1, 'WS must still have exactly the one converged outcome row, unaffected by the other workspace');
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(outcomeDefinitions).where(eq(outcomeDefinitions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
