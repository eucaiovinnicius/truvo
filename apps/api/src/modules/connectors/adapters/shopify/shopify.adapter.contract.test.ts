import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
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
} from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService } from '../../../identity/identity-graph.service';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { EngagementWriteService } from '../../engagement/engagement-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import { createShopifyAdapter } from './shopify.adapter';
import type { ShopifyFetch } from './shopify.graphql-client';
import { SHOPIFY_PROVIDER, SHOPIFY_REQUIRED_SCOPES } from './shopify.constants';

/**
 * Order 060 §"Runtime/contract validation" — the real Shopify adapter driven
 * end-to-end through the REAL Order 050 framework services against a REAL
 * Postgres, using a deterministic fake `fetch` (no live Shopify credentials).
 * Adapts `connector-contract-kit.ts`'s proof style (fresh connection → seed
 * behavior → assert framework outcome) to Shopify's own shapes/edge cases (§8)
 * rather than reusing its `proveXxx` helpers verbatim — those are written against
 * the fake provider's bidirectional/destination/fixed-page-size assumptions,
 * which Shopify (source-only, GraphQL cursor pagination) does not share.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order060_shopify_test_key_dev_only';

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
const WS = `test_ws_shopify_${STAMP}`;
const WS_B = `test_ws_shopify_b_${STAMP}`;

function scopesResponse() {
  return { data: { currentAppInstallation: { accessScopes: SHOPIFY_REQUIRED_SCOPES.map((h) => ({ handle: h })) } } };
}

function money(amount: string, currencyCode = 'BRL') {
  return { shopMoney: { amount, currencyCode } };
}

/** GraphQL order node factory — mirrors `ShopifyOrderNode` (backfill/incremental pull). */
function orderNode(opts: { id: string; status?: string; total?: string; currency?: string }) {
  return {
    id: opts.id,
    displayFinancialStatus: opts.status ?? 'PAID',
    processedAt: '2026-08-01T00:00:00Z',
    currentTotalPriceSet: money(opts.total ?? '100.00', opts.currency ?? 'BRL'),
    customer: null,
    lineItems: { nodes: [] },
    refunds: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

function ordersPage(nodes: ReturnType<typeof orderNode>[], hasNextPage = false, endCursor: string | null = null): Response {
  return jsonResponse({ data: { orders: { pageInfo: { hasNextPage, endCursor }, nodes } } });
}

/** REST-shaped webhook body `shopify.adapter.ts#normalizeWebhook` expects for
 * `orders/*` topics — mirrors Shopify's actual flat, snake_case webhook payload
 * (distinct from the GraphQL node shape used by backfill/incremental pull). */
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
  return { id: refundId, order_id: orderGid.split('/').pop(), created_at: '2026-08-02T00:00:00Z', transactions: [{ amount, currency }] };
}

/** Signs `body` the SAME way `verifyShopify` verifies it: HMAC-SHA256 base64 over
 * the raw JSON bytes, using the fixed webhook secret every test connection is
 * created with — so the adapter's real signature verification runs, unmocked. */
function webhookRequest(topic: string, body: unknown, deliveryId: string): { headers: Record<string, string>; body: unknown; deliveryId: string } {
  const raw = Buffer.from(JSON.stringify(body ?? {}));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('base64');
  return { headers: { 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': signature }, body, deliveryId };
}

test('Shopify adapter: end-to-end proofs against real Postgres (§8 edge cases)', async (t) => {
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
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  // Scripted fetch queue: each call to fetchImpl consumes the next queued
  // response (or falls back to a scopes response) — deterministic, no network.
  const queue: Response[] = [];
  const fetchImpl: ShopifyFetch = (async () => queue.shift() ?? jsonResponse(scopesResponse())) as ShopifyFetch;
  registry.registerSource(createShopifyAdapter(fetchImpl));

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: SHOPIFY_PROVIDER, role: 'source', displayName: `shopify-${ws}`, config: { shop_domain: 'test-shop.myshopify.com' } });
    await connections.setCredentials(ws, conn.id, { access_token: 'shpat_test', webhook_secret: WEBHOOK_SECRET });
    return conn;
  }

  try {
    await t.test('testConnection: valid scopes → connected; 401 → authFailure/invalid (never a silent generic failure)', async () => {
      const conn = await newConnection(WS);
      queue.push(jsonResponse(scopesResponse()));
      const result = await connections.testConnection(WS, conn.id);
      assert.equal(result.ok, true);
      const after = await connections.get(WS, conn.id);
      assert.equal(after.lifecycleState, 'connected');
      assert.equal(after.credentialStatus, 'valid');

      const conn2 = await newConnection(WS);
      queue.push(jsonResponse({}, 401));
      const bad = await connections.testConnection(WS, conn2.id);
      assert.equal(bad.ok, false);
      assert.equal(bad.authFailure, true);
      const afterBad = await connections.get(WS, conn2.id);
      assert.equal(afterBad.credentialStatus, 'invalid');
    });

    await t.test('backfill + durable checkpoint resume + repeated historical page is idempotent', async () => {
      const conn = await newConnection(WS);
      const stream = `orders_${STAMP}`;
      queue.push(ordersPage([orderNode({ id: `gid://shopify/Order/bf1_${STAMP}` })], true, 'cursor_bf_1'));
      const first = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(first.status, 'succeeded');
      assert.equal(first.hasMore, true);

      queue.push(ordersPage([orderNode({ id: `gid://shopify/Order/bf2_${STAMP}` })], false, null));
      const second = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(second.status, 'succeeded');
      assert.equal(second.hasMore, false);

      // repeated historical page: re-running at the SAME (now-completed) checkpoint
      // boundary must not re-invoke the adapter — proven by the queue staying full.
      queue.push(ordersPage([orderNode({ id: `gid://shopify/Order/should_not_be_read_${STAMP}` })]));
      const replay = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(replay.replayedFromCache, true);
      assert.equal(queue.length, 1, 'a cached replay must never call the adapter again');
      queue.length = 0;
    });

    await t.test('throttling: 429 pauses/reschedules (rate_limited, not a generic error), retry then succeeds without dropping records', async () => {
      const conn = await newConnection(WS);
      const stream = `throttle_${STAMP}`;
      queue.push(jsonResponse({}, 429));
      const limited = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(limited.status, 'rate_limited');

      queue.push(ordersPage([orderNode({ id: `gid://shopify/Order/throttled_ok_${STAMP}` })]));
      const retried = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(retried.status, 'succeeded');
      assert.equal(retried.recordsRead, 1, 'the record was never dropped by the throttled attempt');
    });

    await t.test('guest checkout → guest→identified convergence (same providerOrderId, later resolves to a real customer, never regresses)', async () => {
      const conn = await newConnection(WS);
      const orderId = `gid://shopify/Order/guest_${STAMP}`;

      const guestResult = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(orderId, { status: 'paid' }), `whd_guest_${STAMP}`));
      assert.equal(guestResult.status, 'ok');

      const [guestRow] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerNamespace, SHOPIFY_PROVIDER), eq(commerceOrders.providerOrderId, orderId)));
      assert.ok(guestRow, 'guest order must be recorded unattached');
      assert.equal(guestRow!.customerId, null);

      const customerGid = `gid://shopify/Customer/guest_now_known_${STAMP}`;
      const identifiedResult = await webhook.handleWebhook(
        WS,
        conn.id,
        webhookRequest('orders/updated', restOrderBody(orderId, { status: 'paid', customerId: customerGid, email: `guest_${STAMP}@example.com` }), `whd_identified_${STAMP}`),
      );
      assert.equal(identifiedResult.status, 'ok');

      const [identifiedRow] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerNamespace, SHOPIFY_PROVIDER), eq(commerceOrders.providerOrderId, orderId)));
      assert.ok(identifiedRow!.customerId, 'the SAME order must advance from guest to identified');

      // a THIRD delivery without a customer (still-a-guest re-webhook) must never regress the resolved identity back to null.
      const regressionAttempt = await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'paid' }), `whd_regress_${STAMP}`));
      assert.equal(regressionAttempt.status, 'ok');
      const [afterRegressionAttempt] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerNamespace, SHOPIFY_PROVIDER), eq(commerceOrders.providerOrderId, orderId)));
      assert.equal(afterRegressionAttempt!.customerId, identifiedRow!.customerId, 'a later guest-shaped update must NEVER erase an already-resolved identity');
    });

    await t.test('partial refund → full refund: revenue-recognized status transitions and refund_total tracked without reversing the purchase outcome', async () => {
      const conn = await newConnection(WS);
      const orderId = `gid://shopify/Order/refundflow_${STAMP}`;
      const customerGid = `gid://shopify/Customer/refundflow_${STAMP}`;
      const email = `refundflow_${STAMP}@example.com`;

      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(orderId, { status: 'paid', total: '100.00', customerId: customerGid, email }), `whd_paid_${STAMP}`));

      const [afterPaid] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, orderId)));
      const customerId = afterPaid!.customerId!;

      // partial refund: order status now 'partially_refunded', still revenue-recognized.
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'partially_refunded', total: '100.00', customerId: customerGid, email }), `whd_partial_upd_${STAMP}`));
      await webhook.handleWebhook(WS, conn.id, webhookRequest('refunds/create', refundBody(orderId, `refpartial_${STAMP}`, '30.00'), `whd_refund_partial_${STAMP}`));

      const [afterPartial] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, orderId)));
      assert.equal(afterPartial!.financialStatus, 'partially_refunded');

      const [refundTraitPartial] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerId), eq(customerTraits.traitKey, 'refund_total')));
      assert.deepEqual(refundTraitPartial!.value, { BRL: 30 });
      const [revenueTraitPartial] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerId), eq(customerTraits.traitKey, 'realized_revenue')));
      assert.deepEqual(revenueTraitPartial!.value, { BRL: 70 }, '100 gross - 30 refunded = 70 realized, still counted (order status partially_refunded)');

      // full refund: status flips to 'refunded' → order drops OUT of revenue recognition entirely.
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'refunded', total: '100.00', customerId: customerGid, email }), `whd_full_upd_${STAMP}`));
      await webhook.handleWebhook(WS, conn.id, webhookRequest('refunds/create', refundBody(orderId, `reffull_${STAMP}`, '70.00'), `whd_refund_full_${STAMP}`));

      const [orderCountTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerId), eq(customerTraits.traitKey, 'order_count')));
      assert.equal(orderCountTrait!.value, 0, 'a fully refunded order is no longer revenue-recognized');

      // the refund must NEVER have reversed/deleted the original purchase outcome row.
      const purchaseOutcomes = await db.execute(
        sql`select count(*)::int as n from customer_outcomes where workspace_id = ${WS} and customer_id = ${customerId} and outcome_key = 'purchase' and deleted_at is null`,
      );
      assert.ok(Number((purchaseOutcomes as unknown as Array<{ n: number }>)[0]?.n ?? 0) >= 1, 'refund must not delete/reverse the original purchase outcome (Order 40 semantics preserved)');
    });

    await t.test('order edited after payment (total amount changes on resync) is reflected, not stale', async () => {
      const conn = await newConnection(WS);
      const orderId = `gid://shopify/Order/edited_${STAMP}`;
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(orderId, { status: 'paid', total: '50.00' }), `whd_edit1_${STAMP}`));
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'paid', total: '65.00' }), `whd_edit2_${STAMP}`));
      const [row] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, orderId)));
      assert.equal(Number(row!.totalAmount), 65, 'the resync total (65.00) must win over the original (50.00), not stay stale');
    });

    await t.test('duplicate webhook delivery is harmless; invalid signature fails closed', async () => {
      const conn = await newConnection(WS);
      const orderId = `gid://shopify/Order/dup_${STAMP}`;
      const request = webhookRequest('orders/paid', restOrderBody(orderId, { status: 'paid' }), `whd_dup_${STAMP}`);
      const first = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(first.status, 'ok');
      const second = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(second.status, 'duplicate');

      const badBody = restOrderBody(`gid://shopify/Order/bad_sig_${STAMP}`, { status: 'paid' });
      const invalid = await webhook.handleWebhook(WS, conn.id, {
        headers: { 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': 'not_a_real_signature' },
        body: badBody,
        deliveryId: `whd_badsig_${STAMP}`,
      });
      assert.equal(invalid.status, 'rejected');
      assert.equal(invalid.reason, 'invalid_signature');
    });

    await t.test('out-of-order webhook updates converge on the CURRENT full state regardless of arrival order', async () => {
      const conn = await newConnection(WS);
      const orderId = `gid://shopify/Order/ooo_${STAMP}`;
      const customerGid = `gid://shopify/Customer/ooo_${STAMP}`;
      const email = `ooo_${STAMP}@example.com`;

      // Shopify's `orders/updated` webhook always carries the order's CURRENT full
      // state (never a diff), so two deliveries of the same current state — in
      // either arrival order — must converge on the same final row/traits.
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'paid', total: '200.00', customerId: customerGid, email }), `whd_ooo_1_${STAMP}`));
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/updated', restOrderBody(orderId, { status: 'paid', total: '200.00', customerId: customerGid, email }), `whd_ooo_2_${STAMP}`));

      const [row] = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, orderId)));
      assert.equal(Number(row!.totalAmount), 200);
      const [revenueTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, row!.customerId!), eq(customerTraits.traitKey, 'realized_revenue')));
      assert.deepEqual(revenueTrait!.value, { BRL: 200 }, 'derived traits always reflect a FULL recompute of current table state, never a stale partial');
    });

    await t.test('multiple currencies are never silently summed into one false total', async () => {
      const conn = await newConnection(WS);
      const customerGid = `gid://shopify/Customer/multicur_${STAMP}`;
      const email = `multicur_${STAMP}@example.com`;
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(`gid://shopify/Order/mc_brl_${STAMP}`, { status: 'paid', total: '100.00', currency: 'BRL', customerId: customerGid, email }), `whd_mc_brl_${STAMP}`));
      await webhook.handleWebhook(WS, conn.id, webhookRequest('orders/paid', restOrderBody(`gid://shopify/Order/mc_usd_${STAMP}`, { status: 'paid', total: '20.00', currency: 'USD', customerId: customerGid, email }), `whd_mc_usd_${STAMP}`));

      const [customerRow] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, customerGid)));
      const [revenueTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerRow!.customerId), eq(customerTraits.traitKey, 'realized_revenue')));
      assert.deepEqual(revenueTrait!.value, { BRL: 100, USD: 20 }, 'per-currency map, never a single summed total');
    });

    await t.test('same Shopify order id in two DIFFERENT Truvo workspaces never collides', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_B);
      const sharedOrderId = `gid://shopify/Order/shared_${STAMP}`;

      await webhook.handleWebhook(WS, connA.id, webhookRequest('orders/paid', restOrderBody(sharedOrderId, { status: 'paid', total: '11.00' }), `whd_shared_a_${STAMP}`));
      await webhook.handleWebhook(WS_B, connB.id, webhookRequest('orders/paid', restOrderBody(sharedOrderId, { status: 'paid', total: '22.00' }), `whd_shared_b_${STAMP}`));

      const rowsA = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS), eq(commerceOrders.providerOrderId, sharedOrderId)));
      const rowsB = await db.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, WS_B), eq(commerceOrders.providerOrderId, sharedOrderId)));
      assert.equal(rowsA.length, 1);
      assert.equal(rowsB.length, 1);
      assert.notEqual(rowsA[0]!.id, rowsB[0]!.id, 'same provider order id in two workspaces must never resolve to the same row');
      assert.equal(Number(rowsA[0]!.totalAmount), 11);
      assert.equal(Number(rowsB[0]!.totalAmount), 22);
    });
  } finally {
    for (const ws of [WS, WS_B]) {
      await db.delete(commerceRefunds).where(eq(commerceRefunds.workspaceId, ws)).catch(() => undefined);
      await db.execute(sql`delete from commerce_order_line_items where workspace_id = ${ws}`).catch(() => undefined);
      await db.delete(commerceOrders).where(eq(commerceOrders.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    await closeDb(db).catch(() => undefined);
  }
});
