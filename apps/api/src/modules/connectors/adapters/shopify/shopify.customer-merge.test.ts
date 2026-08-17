import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  connectorConnections,
  connectorSyncCheckpoints,
  connectorSyncRuns,
  commerceOrders,
  commerceRefunds,
  customers,
  customerIdentifiers,
  customerTraits,
  customerOutcomes,
} from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService } from '../../../identity/identity-graph.service';
import { closeRedis } from '../../../identity/identity.infra';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { EngagementWriteService } from '../../engagement/engagement-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import { createShopifyAdapter } from './shopify.adapter';
import type { ShopifyFetch } from './shopify.graphql-client';
import { SHOPIFY_PROVIDER } from './shopify.constants';

/**
 * ORDER_060_SHOPIFY_CUSTOMER_MERGE_VERIFICATION — the one Order 060 edge case not
 * directly exercised by `shopify.adapter.contract.test.ts`: a Shopify identity
 * whose canonical customer gets MERGED (via the real Order 45
 * `IdentityGraphService.mergeCustomers`, never by editing an id directly) must
 * converge onto the surviving customer on the next sync, with no split/duplicate
 * state left behind.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order060_merge_verification_test_key_dev_only';

const WEBHOOK_SECRET = 'wh_secret';

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
const WS = `test_ws_shopify_merge_${STAMP}`;
const WS_OTHER = `test_ws_shopify_merge_other_${STAMP}`;

function restOrderBody(gid: string, opts: { status: string; total?: string; currency?: string; customerId?: string; email?: string }) {
  return {
    id: gid.split('/').pop(),
    financial_status: opts.status,
    processed_at: '2026-08-01T00:00:00Z',
    total_price: opts.total ?? '100.00',
    currency: opts.currency ?? 'BRL',
    customer: opts.customerId ? { id: opts.customerId.split('/').pop(), email: opts.email } : null,
    line_items: [],
  };
}

function refundBody(orderGid: string, refundId: string, amount: string, currency = 'BRL') {
  return { id: refundId, order_id: orderGid.split('/').pop(), created_at: '2026-08-05T00:00:00Z', transactions: [{ amount, currency }] };
}

function webhookRequest(topic: string, body: unknown, deliveryId: string): { headers: Record<string, string>; body: unknown; deliveryId: string } {
  const raw = Buffer.from(JSON.stringify(body ?? {}));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('base64');
  return { headers: { 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': signature }, body, deliveryId };
}

test('Shopify + Identity Graph v2: customer merge convergence (real Postgres, real mergeCustomers)', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const registry = new ConnectorRegistryService();
  const connections = new ConnectorConnectionService(db, audit, registry);
  const commerce = new CommerceWriteService(db, customerContext);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, new BillingContextWriteService(db, customerContext), new CrmWriteService(db), new EngagementWriteService(db, customerContext));
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const fetchImpl: ShopifyFetch = (async () => {
    throw new Error('unexpected fetch call — this test only exercises the webhook path');
  }) as ShopifyFetch;
  registry.registerSource(createShopifyAdapter(fetchImpl));

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: SHOPIFY_PROVIDER, role: 'source', displayName: `shopify-merge-${ws}`, config: { shop_domain: 'test-shop.myshopify.com' } });
    await connections.setCredentials(ws, conn.id, { access_token: 'shpat_test', webhook_secret: WEBHOOK_SECRET });
    return conn;
  }

  const customer1Gid = `gid://shopify/Customer/merge_c1_${STAMP}`;
  const customer2Gid = `gid://shopify/Customer/merge_c2_${STAMP}`;
  const email1 = `merge_c1_${STAMP}@example.com`;
  const email2 = `merge_c2_${STAMP}@example.com`;
  const order1Gid = `gid://shopify/Order/merge_o1_${STAMP}`;
  const order2Gid = `gid://shopify/Order/merge_o2_${STAMP}`;

  try {
    const conn = await newConnection(WS);

    // 1. Shopify identity #1 (customer1/order1) resolves to canonical customer A.
    const step1 = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(order1Gid, { status: 'paid', total: '100.00', customerId: customer1Gid, email: email1 }), `whd_merge_o1_${STAMP}`));
    assert.equal(step1.status, 'ok');

    const [identifier1Before] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, customer1Gid)));
    const customerA = identifier1Before!.customerId;

    // 2. Shopify identity #2 (customer2/order2) resolves to a SEPARATE canonical customer B.
    const step2 = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(order2Gid, { status: 'paid', total: '50.00', customerId: customer2Gid, email: email2 }), `whd_merge_o2_${STAMP}`));
    assert.equal(step2.status, 'ok');

    const [identifier2Before] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, customer2Gid)));
    const customerB = identifier2Before!.customerId;
    assert.notEqual(customerA, customerB, 'the two Shopify identities must start as two DIFFERENT canonical customers');

    // 3. Real Order 45 merge: A → B. NEVER editing customer ids directly.
    const mergeResult = await identityGraph.mergeCustomers({
      workspaceId: WS,
      sourceCustomerId: customerA!,
      targetCustomerId: customerB!,
      reason: 'order060 merge verification test',
      sourceNamespace: 'test.merge_verification',
      actor: { type: 'system', id: 'order060-test' },
    });
    assert.equal(mergeResult.status, 'merged');

    const [customerARow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, customerA!)));
    assert.equal(customerARow!.status, 'merged');
    assert.equal(customerARow!.mergedIntoCustomerId, customerB);

    // Immediately after merge (before any Shopify resync), the GID1 identifier row
    // must already point to B — Identity Graph v2's own guarantee.
    const [identifier1AfterMerge] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, customer1Gid)));
    assert.equal(identifier1AfterMerge!.customerId, customerB, 'GID1 must resolve to the surviving customer B immediately after the merge');

    // 4. Replay a realistic SUBSEQUENT Shopify order update for the ORIGINAL identity.
    const step4 = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(order1Gid, { status: 'paid', total: '100.00', customerId: customer1Gid, email: email1 }), `whd_merge_o1_update_${STAMP}`));
    assert.equal(step4.status, 'ok');

    // 5. ... and a subsequent refund on that same original order.
    const step5 = await webhook.handleWebhook(WS, conn.id, webhookRequest('refunds/create', refundBody(order1Gid, `merge_ref_${STAMP}`, '20.00'), `whd_merge_refund_${STAMP}`));
    assert.equal(step5.status, 'ok');

    // --- Assertions -------------------------------------------------------

    await t.test('order1 attaches to the surviving customer B, not the merged/deactivated A', async () => {
      const rows = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, order1Gid)));
      assert.equal(rows.length, 1, 'no duplicate commerce_orders row for the same provider order identity');
      assert.equal(rows[0]!.customerId, customerB, 'order1 must have moved from A to B');
      assert.notEqual(rows[0]!.customerId, customerA, 'order1 must NOT remain attached to the merged-away customer A');
    });

    await t.test('no duplicate purchase customer_outcomes row; the surviving row belongs to B', async () => {
      const outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, order1Gid)));
      assert.equal(outcomes.length, 1, 'exactly one purchase outcome for order1 — merge must not have created a second');
      assert.equal(outcomes[0]!.customerId, customerB, 'the purchase outcome must have converged onto B, not stayed pinned to A');
    });

    await t.test('derived commerce traits converge on B (both orders counted, refund applied) and are not split/stale across A/B', async () => {
      const [orderCountTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'order_count')));
      assert.equal(orderCountTrait!.value, 2, 'B must now own BOTH order1 (reattached) and order2 (its own)');

      const [revenueTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'realized_revenue')));
      assert.deepEqual(revenueTrait!.value, { BRL: 130 }, '(100 - 20 refunded) + 50 = 130, converged under B');

      const [refundTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'refund_total')));
      assert.deepEqual(refundTrait!.value, { BRL: 20 });
    });

    await t.test('replay is idempotent: resending the post-merge order update again does not duplicate or diverge state', async () => {
      const replay = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(order1Gid, { status: 'paid', total: '100.00', customerId: customer1Gid, email: email1 }), `whd_merge_o1_update_replay_${STAMP}`));
      assert.equal(replay.status, 'ok');

      const rows = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, order1Gid)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB);

      const outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, order1Gid)));
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.customerId, customerB);

      const [orderCountTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'order_count')));
      assert.equal(orderCountTrait!.value, 2, 'replay must not double-count order1');
    });

    await t.test('another workspace with the IDENTICAL Shopify provider IDs is completely unaffected by this merge', async () => {
      const connOther = await newConnection(WS_OTHER);
      const otherResult = await webhook.handleWebhook(WS_OTHER, connOther.id, webhookRequest('orders/paid', restOrderBody(order1Gid, { status: 'paid', total: '999.00', customerId: customer1Gid, email: email1 }), `whd_merge_isolation_${STAMP}`));
      assert.equal(otherResult.status, 'ok');

      const otherRows = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS_OTHER), eq(commerceOrders.providerOrderId, order1Gid)));
      assert.equal(otherRows.length, 1);
      assert.equal(otherRows[0]!.totalAmount.startsWith('999'), true, 'a same-id order in a different workspace is a completely independent row');

      const [otherIdentifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_OTHER), eq(customerIdentifiers.identifierValue, customer1Gid)));
      assert.notEqual(otherIdentifier!.customerId, customerB, 'the OTHER workspace must resolve its own independent canonical customer, never workspace WS\'s merge target B');

      const wsRows = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, order1Gid)));
      assert.equal(Number(wsRows[0]!.totalAmount), 100, 'the original workspace\'s order1 must be untouched by the other workspace\'s activity');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(commerceRefunds).where(eq(commerceRefunds.workspaceId, ws)).catch(() => undefined);
      await db.delete(commerceOrders).where(eq(commerceOrders.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    await closeDb(db).catch(() => undefined);
    closeRedis();
  }
});
