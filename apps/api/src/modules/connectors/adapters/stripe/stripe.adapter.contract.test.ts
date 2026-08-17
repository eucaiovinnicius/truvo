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
  billingContextSubscriptions,
  billingContextInvoices,
  billingContextPayments,
  billingContextAdjustments,
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
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import { createStripeAdapter } from './stripe.adapter';
import type { StripeFetch } from './stripe.api-client';
import { STRIPE_PROVIDER } from './stripe.constants';

/**
 * Order 062 (Stripe context connector, closure 02) — the real Stripe adapter
 * driven end-to-end through the REAL Order 050 framework services (orchestrator,
 * webhook service, canonical mapping → Identity Graph v2 / billing context) against
 * a REAL Postgres, using a deterministic fake `fetch` (no live Stripe credentials).
 * Mirrors the rigor/structure of `hubspot.adapter.contract.test.ts`: hand-built
 * provider-shaped fixtures + a single shift-based response queue, one `t.test()`
 * block per independently-assertable scenario.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order062_stripe_adapter_contract_test_key_dev_only';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_order062_adapter_contract';
process.env.STRIPE_CONNECT_CLIENT_ID ??= 'ca_test_order062_adapter_contract';
process.env.STRIPE_OAUTH_STATE_SECRET ??= 'order062_stripe_adapter_contract_oauth_state_secret';

const ACCOUNT_ID = 'acct_order062_test';
const WEBHOOK_SECRET = 'whsec_order062_test';

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
const WS = `test_ws_stripe_${STAMP}`;
const WS_OTHER = `test_ws_stripe_other_${STAMP}`;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null }, json: async () => body } as unknown as Response;
}
function pageResponse(data: unknown[], hasMore = false): Response {
  return jsonResponse({ data, has_more: hasMore });
}

function customerNode(id: string, opts: { email?: string; phone?: string; created?: number } = {}) {
  return { id, email: opts.email, phone: opts.phone, created: opts.created ?? nowSec() };
}
function subscriptionNode(id: string, opts: { customerId: string; status?: string; quantity?: number; priceId?: string; productId?: string; trialStart?: number; trialEnd?: number; periodStart?: number; periodEnd?: number; cancelAt?: number; cancelledAt?: number; endedAt?: number; created?: number }) {
  return {
    id,
    customer: opts.customerId,
    status: opts.status ?? 'active',
    items: { data: [{ quantity: opts.quantity ?? 1, price: { id: opts.priceId ?? 'price_default', product: opts.productId ?? 'prod_default' } }] },
    start_date: opts.created ?? nowSec(),
    trial_start: opts.trialStart,
    trial_end: opts.trialEnd,
    current_period_start: opts.periodStart,
    current_period_end: opts.periodEnd,
    cancel_at: opts.cancelAt,
    canceled_at: opts.cancelledAt,
    ended_at: opts.endedAt,
    created: opts.created ?? nowSec(),
  };
}
function invoiceNode(id: string, opts: { customerId: string; subscriptionId?: string; status?: string; currency?: string; amountDue?: number; amountPaid?: number; amountRemaining?: number; paidAt?: number; created?: number }) {
  return {
    id,
    customer: opts.customerId,
    subscription: opts.subscriptionId,
    status: opts.status ?? 'paid',
    currency: opts.currency ?? 'usd',
    amount_due: opts.amountDue ?? 0,
    amount_paid: opts.amountPaid ?? 1000,
    amount_remaining: opts.amountRemaining ?? 0,
    created: opts.created ?? nowSec(),
    status_transitions: { paid_at: opts.paidAt ?? (opts.status === 'paid' ? nowSec() : undefined) },
  };
}
function paymentIntentNode(id: string, opts: { customerId: string; invoiceId?: string; status?: string; amount?: number; currency?: string; created?: number }) {
  return { id, customer: opts.customerId, invoice: opts.invoiceId, status: opts.status ?? 'succeeded', amount_received: opts.amount ?? 1000, amount: opts.amount ?? 1000, currency: opts.currency ?? 'usd', created: opts.created ?? nowSec() };
}
function refundNode(id: string, opts: { customerId: string; chargeId?: string; paymentIntentId?: string; invoiceId?: string; amount?: number; currency?: string; created?: number }) {
  return { id, customer: opts.customerId, charge: opts.chargeId, payment_intent: opts.paymentIntentId, invoice: opts.invoiceId, amount: opts.amount ?? 200, currency: opts.currency ?? 'usd', status: 'succeeded', created: opts.created ?? nowSec() };
}

function stripeWebhookRequest(type: string, object: unknown, opts: { eventId?: string; createdSec?: number; secret?: string } = {}) {
  const eventId = opts.eventId ?? `evt_${type.replace(/\./g, '_')}_${STAMP}_${Math.random().toString(36).slice(2)}`;
  const body = { id: eventId, type, created: opts.createdSec ?? nowSec(), data: { object } };
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  return { headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body, rawBody: raw };
}

test('Stripe adapter: end-to-end proofs against real Postgres (Order 062 §ORDER_062 edge cases)', async (t) => {
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
  const billing = new BillingContextWriteService(db, customerContext);
  const crm = new CrmWriteService(db, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm, new EngagementWriteService(db, customerContext));
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const calls: string[] = [];
  const queue: Response[] = [];
  const fetchImpl: StripeFetch = (async (url: string) => {
    calls.push(url);
    return queue.shift() ?? jsonResponse({ data: [], has_more: false });
  }) as StripeFetch;
  const adapter = createStripeAdapter(fetchImpl);
  registry.registerSource(adapter);

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: STRIPE_PROVIDER, role: 'source', displayName: `stripe-${ws}-${Date.now()}-${Math.random()}` });
    await connections.setCredentials(ws, conn.id, { connected_account_id: ACCOUNT_ID, webhook_secret: WEBHOOK_SECRET, livemode: false });
    return conn;
  }

  try {
    await t.test('historical sync across all 5 streams: pagination, checkpoint resume (starting_after sent), replay idempotency', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_hist_${STAMP}`;

      async function pagedStream(streamKey: string, ids: [string, string, string], build: (id: string) => unknown) {
        queue.push(pageResponse([build(ids[0]), build(ids[1])], true));
        const first = await orchestrator.runBackfill(WS, conn.id, streamKey);
        assert.equal(first.status, 'succeeded', `${streamKey}: first page succeeds`);
        assert.equal(first.recordsRead, 2, `${streamKey}: first page reads 2 records`);
        assert.equal(first.hasMore, true, `${streamKey}: first page reports hasMore`);
        assert.equal(calls[calls.length - 1]!.includes('starting_after='), false, `${streamKey}: first page must not send a cursor`);

        queue.push(pageResponse([build(ids[2])], false));
        const second = await orchestrator.runBackfill(WS, conn.id, streamKey);
        assert.equal(second.status, 'succeeded', `${streamKey}: second (resumed) page succeeds`);
        assert.equal(second.recordsRead, 1, `${streamKey}: resumed page reads exactly the 1 remaining record — page 1 was not re-read`);
        assert.equal(second.hasMore, false, `${streamKey}: second page completes the backfill`);
        assert.ok(calls[calls.length - 1]!.includes('starting_after='), `${streamKey}: the resumed call must send the durable checkpoint cursor`);

        const callsBeforeReplay = calls.length;
        const replay = await orchestrator.runBackfill(WS, conn.id, streamKey);
        assert.equal(replay.replayedFromCache, true, `${streamKey}: replaying a completed backfill must be served from cache`);
        assert.equal(calls.length, callsBeforeReplay, `${streamKey}: a cached replay must never call the adapter again`);
      }

      await pagedStream('customers', [`cus_a_${STAMP}`, `cus_b_${STAMP}`, `cus_c_${STAMP}`], (id) => customerNode(id, { email: `${id}@example.com` }));
      await pagedStream('subscriptions', [`sub_a_${STAMP}`, `sub_b_${STAMP}`, `sub_c_${STAMP}`], (id) => subscriptionNode(id, { customerId: custId }));
      await pagedStream('invoices', [`in_a_${STAMP}`, `in_b_${STAMP}`, `in_c_${STAMP}`], (id) => invoiceNode(id, { customerId: custId }));
      await pagedStream('payments', [`pi_a_${STAMP}`, `pi_b_${STAMP}`, `pi_c_${STAMP}`], (id) => paymentIntentNode(id, { customerId: custId }));
      await pagedStream('refunds', [`re_a_${STAMP}`, `re_b_${STAMP}`, `re_c_${STAMP}`], (id) => refundNode(id, { customerId: custId }));

      // Replay idempotency, literally: row COUNT stays the same after the replay
      // already exercised above (each stream did page1 → page2 → replay).
      const subRows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerCustomerId, custId)));
      assert.equal(subRows.length, 3, 'subscriptions: 3 distinct rows, no duplication from the replay');
      const invRows = await db.select().from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, WS), eq(billingContextInvoices.providerCustomerId, custId)));
      assert.equal(invRows.length, 3, 'invoices: 3 distinct rows, no duplication from the replay');
      const payRows = await db.select().from(billingContextPayments).where(and(eq(billingContextPayments.workspaceId, WS), eq(billingContextPayments.providerCustomerId, custId)));
      assert.equal(payRows.length, 3, 'payments: 3 distinct rows, no duplication from the replay');
      const adjRows = await db.select().from(billingContextAdjustments).where(and(eq(billingContextAdjustments.workspaceId, WS), eq(billingContextAdjustments.providerCustomerId, custId)));
      assert.equal(adjRows.length, 3, 'refunds/adjustments: 3 distinct rows, no duplication from the replay');
      const custRows = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.providerNamespace, STRIPE_PROVIDER)));
      const custIds = custRows.map((r) => r.identifierValue);
      for (const id of [`cus_a_${STAMP}`, `cus_b_${STAMP}`, `cus_c_${STAMP}`]) assert.ok(custIds.includes(id), `customers stream must have created identifier ${id}`);
    });

    await t.test('subscription lifecycle: trial -> active', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_lifecycle1_${STAMP}`;
      const subId = `sub_lifecycle1_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subId, { customerId: custId, status: 'trialing', trialEnd: nowSec() + 86400 }), { createdSec: 1000 }));
      let [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.status, 'trialing');

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active' }), { createdSec: 2000 }));
      [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.status, 'active', 'trial -> active transition must land on the same natural-key row');
    });

    await t.test('subscription lifecycle: past_due -> active after a later successful invoice.paid', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_lifecycle2_${STAMP}`;
      const subId = `sub_lifecycle2_${STAMP}`;
      const invId = `in_lifecycle2_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'past_due' }), { createdSec: 1000 }));
      let [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.status, 'past_due');

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('invoice.paid', invoiceNode(invId, { customerId: custId, subscriptionId: subId, status: 'paid' }), { createdSec: 1500 }));
      const [invRow] = await db.select().from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, WS), eq(billingContextInvoices.providerInvoiceId, invId)));
      assert.equal(invRow!.status, 'paid');

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active' }), { createdSec: 2000 }));
      [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.status, 'active');
    });

    await t.test('scheduled cancellation (cancel_at, still active) is distinguishable from effective cancellation (canceled + ended_at)', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_lifecycle3_${STAMP}`;
      const subScheduled = `sub_sched_${STAMP}`;
      const subEffective = `sub_eff_${STAMP}`;
      const futureCancelAt = nowSec() + 30 * 86400;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subScheduled, { customerId: custId, status: 'active', cancelAt: futureCancelAt }), { createdSec: 1000 }));
      const [scheduledRow] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subScheduled)));
      assert.equal(scheduledRow!.status, 'active', 'a scheduled cancellation stays active until the period actually ends');
      assert.ok(scheduledRow!.cancelAt, 'cancel_at must be recorded');
      assert.equal(scheduledRow!.endedAt, null, 'ended_at must NOT be set for a merely-scheduled cancellation');

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.deleted', subscriptionNode(subEffective, { customerId: custId, status: 'canceled', cancelledAt: nowSec(), endedAt: nowSec() }), { createdSec: 1000 }));
      const [effectiveRow] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subEffective)));
      assert.equal(effectiveRow!.status, 'canceled', 'an effective cancellation is status=canceled');
      assert.ok(effectiveRow!.endedAt, 'ended_at must be set for an effective cancellation');
    });

    await t.test('quantity-only change on the same subscription id updates in place — no new row', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_lifecycle4_${STAMP}`;
      const subId = `sub_qty_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', quantity: 1 }), { createdSec: 1000 }));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', quantity: 5 }), { createdSec: 2000 }));

      const rows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(rows.length, 1, 'same natural key — one row, not duplicated');
      assert.equal(rows[0]!.quantity, 5);
    });

    await t.test('price/product change on an existing subscription is a neutral field update — no commerceOrder/outcome fabricated', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_lifecycle5_${STAMP}`;
      const subId = `sub_price_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', priceId: 'price_basic', productId: 'prod_basic' }), { createdSec: 1000 }));
      const outcomesBefore = await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS));

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', priceId: 'price_premium', productId: 'prod_premium' }), { createdSec: 2000 }));

      const [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.priceReference, 'price_premium');
      assert.equal(row!.productReference, 'prod_premium');

      const outcomesAfter = await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS));
      assert.equal(outcomesAfter.length, outcomesBefore.length, 'a plan change must never fabricate a customerOutcomes row — Stripe never emits commerceOrder/crmDeal');
    });

    await t.test('multiple subscriptions for one Stripe customer persist as distinct rows keyed by providerSubscriptionId', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_multi_${STAMP}`;
      const subA = `sub_multiA_${STAMP}`;
      const subB = `sub_multiB_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subA, { customerId: custId, status: 'active' })));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subB, { customerId: custId, status: 'trialing' })));

      const rows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerCustomerId, custId)));
      assert.equal(rows.length, 2, 'two distinct subscriptions for the same customer must both persist');
      const ids = rows.map((r) => r.providerSubscriptionId).sort();
      assert.deepEqual(ids, [subA, subB].sort());
    });

    await t.test('out-of-order safety: replaying an OLDER subscription webhook after a NEWER one does not regress state', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_ooo_${STAMP}`;
      const subId = `sub_ooo_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active' }), { createdSec: 5000 }));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'past_due' }), { createdSec: 2000 }));

      const [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(row!.status, 'active', 'the OLDER (event created=2000) update must not regress the NEWER (event created=5000) state — the out-of-order guard must hold end-to-end through the real webhook path');
    });

    await t.test('economic semantics (a): invoice.paid for a subscription invoice never creates a customerOutcomes row', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_econ_a_${STAMP}`;
      const subId = `sub_econ_a_${STAMP}`;
      const invId = `in_econ_a_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('invoice.paid', invoiceNode(invId, { customerId: custId, subscriptionId: subId, status: 'paid', amountPaid: 5000 })));

      const outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, invId)));
      assert.equal(outcomes.length, 0, 'Stripe never emits a crmDeal/commerceOrder payload — no outcome mapping exists to fabricate a purchase outcome by default');
    });

    await t.test('economic semantics (b): replaying the identical invoice.paid event id twice does not duplicate the invoice row or double-count amount_paid_by_currency', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_econ_b_${STAMP}`;
      const invId = `in_econ_b_${STAMP}`;
      const request = stripeWebhookRequest('invoice.paid', invoiceNode(invId, { customerId: custId, status: 'paid', amountPaid: 3000, currency: 'usd' }), { eventId: `evt_econ_b_${STAMP}` });

      const first = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(first.status, 'ok');
      const second = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(second.status, 'duplicate', 'the identical Stripe event id replayed must be harmless');

      const rows = await db.select().from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, WS), eq(billingContextInvoices.providerInvoiceId, invId)));
      assert.equal(rows.length, 1);

      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custId)));
      const [trait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifier!.customerId), eq(customerTraits.traitKey, 'amount_paid_by_currency')));
      // Stripe amounts are minor units (cents) on the wire — the mapper's `amount()`
      // divides by 100 (see `stripe.mapper.ts`), so amountPaid: 3000 -> 30.00 major units.
      assert.deepEqual(trait!.value, { USD: 30 }, 'replayed duplicate delivery must not double-count');
    });

    await t.test('economic semantics (c): a refund after the subscription\'s effective cancellation is still correctly stored and linked', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_econ_c_${STAMP}`;
      const subId = `sub_econ_c_${STAMP}`;
      const invId = `in_econ_c_${STAMP}`;
      const chargeId = `ch_econ_c_${STAMP}`;
      const refundId = `re_econ_c_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.deleted', subscriptionNode(subId, { customerId: custId, status: 'canceled', cancelledAt: nowSec(), endedAt: nowSec() }), { createdSec: 1000 }));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('charge.refunded', refundNode(refundId, { customerId: custId, chargeId, invoiceId: invId, amount: 500, currency: 'usd' }), { createdSec: 2000 }));

      const [row] = await db.select().from(billingContextAdjustments).where(and(eq(billingContextAdjustments.workspaceId, WS), eq(billingContextAdjustments.providerAdjustmentId, refundId)));
      assert.ok(row, 'the refund must be stored, not dropped, even though the subscription is already canceled');
      assert.equal(row!.providerInvoiceId, invId);
      assert.equal(row!.providerPaymentId, chargeId, 'linked to the right charge (payment reference)');
    });

    await t.test('economic semantics (d): invoices in different currencies for the same customer are kept as separate per-currency keys, never summed', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_econ_d_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('invoice.paid', invoiceNode(`in_econ_d_brl_${STAMP}`, { customerId: custId, status: 'paid', amountPaid: 10000, currency: 'brl' })));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('invoice.paid', invoiceNode(`in_econ_d_usd_${STAMP}`, { customerId: custId, status: 'paid', amountPaid: 5000, currency: 'usd' })));

      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custId)));
      const [trait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifier!.customerId), eq(customerTraits.traitKey, 'amount_paid_by_currency')));
      // amountPaid: 10000/5000 are minor units (cents) -> 100.00 BRL / 50.00 USD major units.
      assert.deepEqual(trait!.value, { BRL: 100, USD: 50 }, 'each currency must keep its own key — never summed together');
    });

    await t.test('upgrade/downgrade scope: an arbitrary price change never fabricates an upgrade/downgrade taxonomy', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_updown_${STAMP}`;
      const subId = `sub_updown_${STAMP}`;

      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', priceId: 'price_lo', productId: 'prod_lo' }), { createdSec: 1000 }));
      await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'active', priceId: 'price_hi', productId: 'prod_hi' }), { createdSec: 2000 }));

      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custId)));
      const traits = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifier!.customerId)));
      const inventedTaxonomy = traits.filter((tr) => /upgrade|downgrade/i.test(tr.traitKey));
      assert.equal(inventedTaxonomy.length, 0, 'no upgrade/downgrade taxonomy is invented — explicitly out of Order 062 scope');

      const outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.dedupeKey, subId)));
      assert.equal(outcomes.length, 0);
    });

    await t.test('reconciliation: a subscription change that never arrives as a webhook is picked up by incrementalPull, and repeating it is idempotent', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_recon_${STAMP}`;
      const subId = `sub_recon_${STAMP}`;

      queue.push(pageResponse([subscriptionNode(subId, { customerId: custId, status: 'active' })], false));
      const first = await orchestrator.runIncremental(WS, conn.id, 'subscriptions');
      assert.equal(first.status, 'succeeded');
      let [row] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.ok(row, 'reconciliation must be able to create canonical state WITHOUT any webhook ever arriving');
      assert.equal(row!.status, 'active');

      queue.push(pageResponse([subscriptionNode(subId, { customerId: custId, status: 'active' })], false));
      const second = await orchestrator.runIncremental(WS, conn.id, 'subscriptions');
      assert.equal(second.status, 'succeeded');
      const rows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(rows.length, 1, 'repeating the same reconciliation must not duplicate rows nor error');
    });

    await t.test('auth failure (testConnection 401) is distinct from an ordinary transient sync failure during a pull', async () => {
      const connAuth = await newConnection(WS);
      queue.push(jsonResponse({}, 401));
      const authResult = await connections.testConnection(WS, connAuth.id);
      assert.equal(authResult.ok, false);
      assert.equal(authResult.authFailure, true);
      const afterAuth = await connections.get(WS, connAuth.id);
      assert.equal(afterAuth.credentialStatus, 'invalid');

      const connSync = await newConnection(WS);
      queue.push(jsonResponse({ id: ACCOUNT_ID }));
      await connections.testConnection(WS, connSync.id);
      const beforeSync = await connections.get(WS, connSync.id);
      assert.equal(beforeSync.credentialStatus, 'valid');

      queue.push(jsonResponse({}, 500));
      await orchestrator.runBackfill(WS, connSync.id, `authvssync_${STAMP}`);
      const afterSync = await connections.get(WS, connSync.id);
      assert.equal(afterSync.credentialStatus, 'valid', 'a transient (500) sync failure must NOT flip credentialStatus');
      assert.notEqual(afterSync.lifecycleState, 'connected', 'lifecycle must reflect the sync problem');
      assert.notEqual(afterSync.credentialStatus, afterAuth.credentialStatus, 'the two failure kinds must leave DIFFERENT credentialStatus');
    });

    await t.test('deauthorization: account.application.deauthorized revokes the connection; a subsequent sync is refused, not blindly polled', async () => {
      const conn = await newConnection(WS);
      const result = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('account.application.deauthorized', {}));
      assert.equal(result.status, 'ok');
      const after = await connections.get(WS, conn.id);
      assert.equal(after.credentialStatus, 'invalid');
      assert.equal(after.lifecycleState, 'disconnected');

      await assert.rejects(
        () => orchestrator.runIncremental(WS, conn.id, 'subscriptions'),
        undefined,
        'a revoked/disconnected connection must not be blindly polled — see ConnectorSyncOrchestratorService disconnected-connection guard',
      );
    });

    await t.test('tenant isolation: identical Stripe ids in two different workspaces remain fully independent', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_OTHER);
      const sharedCust = `cus_shared_${STAMP}`;
      const sharedSub = `sub_shared_${STAMP}`;

      await webhook.handleWebhook(WS, connA.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(sharedSub, { customerId: sharedCust, status: 'active' })));
      await webhook.handleWebhook(WS_OTHER, connB.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(sharedSub, { customerId: sharedCust, status: 'trialing' })));

      const [rowA] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      const [rowB] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS_OTHER), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      assert.notEqual(rowA!.id, rowB!.id, 'same provider ids in different workspaces must be independent rows');
      assert.equal(rowA!.status, 'active');
      assert.equal(rowB!.status, 'trialing');

      const [idA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, sharedCust)));
      const [idB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_OTHER), eq(customerIdentifiers.identifierValue, sharedCust)));
      assert.notEqual(idA!.customerId, idB!.customerId, 'independent derived customers per workspace');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(billingContextAdjustments).where(eq(billingContextAdjustments.workspaceId, ws)).catch(() => undefined);
      await db.delete(billingContextPayments).where(eq(billingContextPayments.workspaceId, ws)).catch(() => undefined);
      await db.delete(billingContextInvoices).where(eq(billingContextInvoices.workspaceId, ws)).catch(() => undefined);
      await db.delete(billingContextSubscriptions).where(eq(billingContextSubscriptions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
