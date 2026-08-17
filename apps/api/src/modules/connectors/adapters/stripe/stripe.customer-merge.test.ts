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
  customers,
  customerIdentifiers,
  customerTraits,
  identitySuppressions,
} from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService, SuppressedIdentifierError } from '../../../identity/identity-graph.service';
import { closeRedis } from '../../../identity/identity.infra';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { EngagementWriteService } from '../../engagement/engagement-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import { createStripeAdapter } from './stripe.adapter';
import type { StripeFetch } from './stripe.api-client';
import { STRIPE_PROVIDER } from './stripe.constants';

/**
 * Order 062 (Stripe context connector, closure 02) — the one edge case not
 * directly exercised by `stripe.adapter.contract.test.ts`: a Stripe identity whose
 * canonical customer gets MERGED (via the real Order 45
 * `IdentityGraphService.mergeCustomers`, never by editing an id directly) must
 * converge onto the surviving customer on the next sync, with no split/duplicate
 * billing state left behind. Mirrors `shopify.customer-merge.test.ts`'s structure.
 * Also covers privacy suppression (Order 55) and tenant isolation under merge.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order062_stripe_merge_verification_test_key_dev_only';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_order062_merge';
process.env.STRIPE_CONNECT_CLIENT_ID ??= 'ca_test_order062_merge';
process.env.STRIPE_OAUTH_STATE_SECRET ??= 'order062_stripe_merge_oauth_state_secret';

const ACCOUNT_ID = 'acct_order062_merge_test';
const WEBHOOK_SECRET = 'whsec_order062_merge_test';

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
const WS = `test_ws_stripe_merge_${STAMP}`;
const WS_OTHER = `test_ws_stripe_merge_other_${STAMP}`;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
function subscriptionNode(id: string, opts: { customerId: string; status?: string; priceId?: string; productId?: string; created?: number }) {
  return { id, customer: opts.customerId, status: opts.status ?? 'active', items: { data: [{ quantity: 1, price: { id: opts.priceId ?? 'price_default', product: opts.productId ?? 'prod_default' } }] }, start_date: opts.created ?? nowSec(), created: opts.created ?? nowSec() };
}
function invoiceNode(id: string, opts: { customerId: string; subscriptionId?: string; status?: string; currency?: string; amountPaid?: number; created?: number }) {
  return { id, customer: opts.customerId, subscription: opts.subscriptionId, status: opts.status ?? 'paid', currency: opts.currency ?? 'usd', amount_due: 0, amount_paid: opts.amountPaid ?? 1000, amount_remaining: 0, created: opts.created ?? nowSec(), status_transitions: { paid_at: nowSec() } };
}
function paymentIntentNode(id: string, opts: { customerId: string; invoiceId?: string; status?: string; amount?: number; currency?: string; created?: number }) {
  return { id, customer: opts.customerId, invoice: opts.invoiceId, status: opts.status ?? 'succeeded', amount_received: opts.amount ?? 1000, amount: opts.amount ?? 1000, currency: opts.currency ?? 'usd', created: opts.created ?? nowSec() };
}
function stripeWebhookRequest(type: string, object: unknown, opts: { eventId?: string; createdSec?: number } = {}) {
  const eventId = opts.eventId ?? `evt_${type.replace(/\./g, '_')}_${STAMP}_${Math.random().toString(36).slice(2)}`;
  const body = { id: eventId, type, created: opts.createdSec ?? nowSec(), data: { object } };
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  return { headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body, rawBody: raw };
}

test('Stripe + Identity Graph v2: customer merge convergence (real Postgres, real mergeCustomers)', async (t) => {
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
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const fetchImpl: StripeFetch = (async () => {
    throw new Error('unexpected fetch call — this test only exercises the webhook path');
  }) as StripeFetch;
  registry.registerSource(createStripeAdapter(fetchImpl));

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: STRIPE_PROVIDER, role: 'source', displayName: `stripe-merge-${ws}` });
    await connections.setCredentials(ws, conn.id, { connected_account_id: ACCOUNT_ID, webhook_secret: WEBHOOK_SECRET, livemode: false });
    return conn;
  }

  const custA = `cus_merge_a_${STAMP}`;
  const custB = `cus_merge_b_${STAMP}`;
  const subA = `sub_merge_a_${STAMP}`;
  const subB = `sub_merge_b_${STAMP}`;

  try {
    const conn = await newConnection(WS);

    // 1. Stripe identity #1 (custA/subA) resolves to canonical customer A.
    const step1 = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subA, { customerId: custA, status: 'active' }), { createdSec: 1000 }));
    assert.equal(step1.status, 'ok');
    const [identifierABefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custA)));
    const customerA = identifierABefore!.customerId;

    // 2. Stripe identity #2 (custB/subB) resolves to a SEPARATE canonical customer B.
    const step2 = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subB, { customerId: custB, status: 'active' }), { createdSec: 1000 }));
    assert.equal(step2.status, 'ok');
    const [identifierBBefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custB)));
    const customerB = identifierBBefore!.customerId;
    assert.notEqual(customerA, customerB, 'the two Stripe identities must start as two DIFFERENT canonical customers');

    // 3. Real Order 45 merge: A -> B. NEVER editing customer ids directly.
    const mergeResult = await identityGraph.mergeCustomers({
      workspaceId: WS,
      sourceCustomerId: customerA!,
      targetCustomerId: customerB!,
      reason: 'order062 stripe merge verification test',
      sourceNamespace: 'test.stripe_merge_verification',
      actor: { type: 'system', id: 'order062-test' },
    });
    assert.equal(mergeResult.status, 'merged');

    const [customerARow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, customerA!)));
    assert.equal(customerARow!.status, 'merged');
    assert.equal(customerARow!.mergedIntoCustomerId, customerB);

    const [identifierAAfterMerge] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custA)));
    assert.equal(identifierAAfterMerge!.customerId, customerB, 'custA must resolve to the surviving customer B immediately after the merge');

    // 4. Replay a LATER Stripe subscription update for the ORIGINAL (A-side) identifier.
    const step4 = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subA, { customerId: custA, status: 'past_due' }), { createdSec: 2000 }));
    assert.equal(step4.status, 'ok');

    // 5. ... and a subsequent invoice + payment for that same original identifier.
    const invA = `in_merge_a_${STAMP}`;
    const step5 = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('invoice.paid', invoiceNode(invA, { customerId: custA, subscriptionId: subA, status: 'paid', amountPaid: 4000 }), { createdSec: 2100 }));
    assert.equal(step5.status, 'ok');

    const payA = `pi_merge_a_${STAMP}`;
    const step6 = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('payment_intent.succeeded', paymentIntentNode(payA, { customerId: custA, invoiceId: invA, status: 'succeeded', amount: 4000 }), { createdSec: 2200 }));
    assert.equal(step6.status, 'ok');

    // --- Assertions -------------------------------------------------------

    await t.test('the original Stripe identifier now resolves to the surviving customer B', async () => {
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custA)));
      assert.equal(identifier!.customerId, customerB);
    });

    await t.test('billing_context_subscriptions row for subA has customerId = B, not a duplicate row', async () => {
      const rows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subA)));
      assert.equal(rows.length, 1, 'no duplicate row for the same providerSubscriptionId');
      assert.equal(rows[0]!.customerId, customerB, 'subA must have moved from A to B');
      assert.notEqual(rows[0]!.customerId, customerA, 'subA must NOT remain attached to the merged-away customer A');
      assert.equal(rows[0]!.status, 'past_due', 'the post-merge update must still apply its own field changes');
    });

    await t.test('billing_context_invoices row for invA has customerId = B', async () => {
      const rows = await db.select().from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, WS), eq(billingContextInvoices.providerInvoiceId, invA)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB);
    });

    await t.test('billing_context_payments row for payA has customerId = B', async () => {
      const rows = await db.select().from(billingContextPayments).where(and(eq(billingContextPayments.workspaceId, WS), eq(billingContextPayments.providerPaymentId, payA)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB);
    });

    await t.test('derived billing traits on B reflect the converged state (both subscriptions counted, not split/stale across A/B)', async () => {
      const [activeCountTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'active_subscription_count')));
      assert.equal(activeCountTrait!.value, 2, 'B must now own BOTH subA (reattached, past_due counts as active) and subB (its own, active)');

      const [paidTrait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitKey, 'amount_paid_by_currency')));
      assert.deepEqual(paidTrait!.value, { USD: 40 }, 'converged under B — 4000 minor units = 40.00 major units');
    });

    await t.test('replay is idempotent: resending the post-merge subscription update again does not duplicate or diverge state', async () => {
      const replay = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subA, { customerId: custA, status: 'past_due' }), { createdSec: 2000 }));
      assert.equal(replay.status, 'ok');

      const rows = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subA)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB);
    });
  } finally {
    await db.delete(billingContextPayments).where(eq(billingContextPayments.workspaceId, WS)).catch(() => undefined);
    await db.delete(billingContextInvoices).where(eq(billingContextInvoices.workspaceId, WS)).catch(() => undefined);
    await db.delete(billingContextSubscriptions).where(eq(billingContextSubscriptions.workspaceId, WS)).catch(() => undefined);
    await db.delete(customerTraits).where(eq(customerTraits.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS)).catch(() => undefined);
    await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});

test('Stripe: privacy suppression prevents identity reconstruction; tenant isolation holds under merge/deauth', async (t) => {
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
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const fetchImpl: StripeFetch = (async () => {
    throw new Error('unexpected fetch call — this test only exercises the webhook path');
  }) as StripeFetch;
  registry.registerSource(createStripeAdapter(fetchImpl));

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: STRIPE_PROVIDER, role: 'source', displayName: `stripe-priv-${ws}` });
    await connections.setCredentials(ws, conn.id, { connected_account_id: ACCOUNT_ID, webhook_secret: WEBHOOK_SECRET, livemode: false });
    return conn;
  }

  try {
    await t.test('suppressing a Stripe-linked identity prevents canonical identity from being silently recreated on a later replay', async () => {
      const conn = await newConnection(WS);
      const custId = `cus_priv_${STAMP}`;
      const subId = `sub_priv_${STAMP}`;

      const first = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(subId, { customerId: custId, status: 'active' }), { createdSec: 1000 }));
      assert.equal(first.status, 'ok');
      const [identifierBefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custId)));
      assert.ok(identifierBefore, 'the identifier must exist before suppression');

      // Order 55 — suppress directly via SuppressionService (Stripe has no
      // provider-native "privacy deletion" webhook event of its own; the erasure
      // signal comes from Truvo's own data-lifecycle subject-erasure flow, which
      // is exactly what SuppressionService.suppress models here).
      await suppression.suppress(WS, { providerNamespace: STRIPE_PROVIDER, identifierType: 'external_id', identifierValue: custId }, { reason: 'order062 privacy suppression test' });

      const [suppressionRow] = await db.select().from(identitySuppressions).where(and(eq(identitySuppressions.workspaceId, WS), eq(identitySuppressions.providerNamespace, STRIPE_PROVIDER), eq(identitySuppressions.identifierValue, custId)));
      assert.ok(suppressionRow, 'the identifier must be suppressed');

      await assert.rejects(
        identityGraph.resolveOrCreateCustomer({ workspaceId: WS, providerNamespace: STRIPE_PROVIDER, identifierType: 'external_id', identifierValue: custId, sourceNamespace: 'test', observedAt: new Date() }),
        SuppressedIdentifierError,
        'a suppressed identifier must never silently reconstruct canonical identity',
      );

      // Replay a historical Stripe update for the SAME identifier through the real
      // webhook path — the record must be skipped (suppressed), not silently
      // recreate a live customer/identifier.
      const replay = await webhook.handleWebhook(WS, conn.id, stripeWebhookRequest('customer.subscription.updated', subscriptionNode(subId, { customerId: custId, status: 'past_due' }), { createdSec: 2000 }));
      assert.equal(replay.status, 'ok', 'the webhook itself is processed (not rejected) — the identifier is just skipped inside canonical mapping');

      const identifierRowsAfter = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, custId)));
      assert.equal(identifierRowsAfter.length, 1, 'no duplicate/new identifier row was created for the suppressed identifier');
      assert.equal(identifierRowsAfter[0]!.customerId, identifierBefore!.customerId, 'no NEW customer was silently created/reattached for the suppressed identifier');

      // The billing FACT itself (an out-of-band provider record) is still durably
      // recorded — suppression governs canonical IDENTITY attachment, not whether
      // a provider's own billing state gets lost (mirrors Order 060's "guest
      // checkout" precedent: the row stays present, just never re-attached to a
      // reconstructed identity — `customerId` keeps pointing at whatever it
      // already resolved to before suppression, never a new/different customer).
      const [subRow] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, subId)));
      assert.equal(subRow!.status, 'past_due', 'the underlying billing fact still updates — suppression is an identity guarantee, not a data-freeze');
      assert.equal(subRow!.customerId, identifierBefore!.customerId, 'the row must stay pinned to its pre-suppression customer, never reassigned to a new one');
    });

    await t.test('tenant isolation: same Stripe ids across two workspaces stay independent; deauthorizing one workspace never mutates the other', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_OTHER);
      const sharedCust = `cus_iso_${STAMP}`;
      const sharedSub = `sub_iso_${STAMP}`;

      await webhook.handleWebhook(WS, connA.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(sharedSub, { customerId: sharedCust, status: 'active' })));
      await webhook.handleWebhook(WS_OTHER, connB.id, stripeWebhookRequest('customer.subscription.created', subscriptionNode(sharedSub, { customerId: sharedCust, status: 'trialing' })));

      const [rowA] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      const [rowB] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS_OTHER), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      assert.notEqual(rowA!.id, rowB!.id);

      // Deauthorize WS's connection — WS_OTHER's connection/rows must be untouched.
      const deauth = await webhook.handleWebhook(WS, connA.id, stripeWebhookRequest('account.application.deauthorized', {}));
      assert.equal(deauth.status, 'ok');
      const afterDeauthA = await connections.get(WS, connA.id);
      assert.equal(afterDeauthA.lifecycleState, 'disconnected');
      const afterDeauthB = await connections.get(WS_OTHER, connB.id);
      assert.notEqual(afterDeauthB.lifecycleState, 'disconnected', 'deauthorizing WS must never mutate WS_OTHER\'s connection');

      const [rowAAfter] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      const [rowBAfter] = await db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, WS_OTHER), eq(billingContextSubscriptions.providerSubscriptionId, sharedSub)));
      assert.equal(rowAAfter!.status, 'active');
      assert.equal(rowBAfter!.status, 'trialing', 'WS_OTHER\'s row must be completely unaffected by WS\'s deauthorization');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(billingContextPayments).where(eq(billingContextPayments.workspaceId, ws)).catch(() => undefined);
      await db.delete(billingContextInvoices).where(eq(billingContextInvoices.workspaceId, ws)).catch(() => undefined);
      await db.delete(billingContextSubscriptions).where(eq(billingContextSubscriptions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
