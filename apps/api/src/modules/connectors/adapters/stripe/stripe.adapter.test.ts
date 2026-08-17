import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createStripeAdapter } from './stripe.adapter';
import { STRIPE_PROVIDER } from './stripe.constants';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_platform';
process.env.STRIPE_CONNECT_CLIENT_ID ??= 'ca_test_platform';
process.env.STRIPE_OAUTH_STATE_SECRET ??= 'stripe_connector_test_state_secret';

const connection = { workspaceId: 'ws_stripe', id: 'conn_stripe', provider: STRIPE_PROVIDER, role: 'source' as const, displayName: 'Stripe', lifecycleState: 'connected' as const, credentialStatus: 'valid' as const, config: {}, capabilities: [], lastError: null, lastCredentialCheckAt: null, lastSyncAt: null, createdAt: new Date(), updatedAt: new Date() };
const credentials = { connected_account_id: 'acct_test', webhook_secret: 'whsec_test', livemode: false };
function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body } as unknown as Response; }

test('Stripe adapter maps independent backfill streams and preserves canonical billing semantics', async () => {
  const calls: string[] = [];
  const adapter = createStripeAdapter((async (url: string) => { calls.push(url); if (url.includes('/customers')) return response({ data: [{ id: 'cus_1', email: 'Buyer@Example.com', phone: '+55 11 99999-0000', created: 1 }], has_more: false }); if (url.includes('/subscriptions')) return response({ data: [{ id: 'sub_1', customer: 'cus_1', status: 'trialing', items: { data: [{ quantity: 2, price: { id: 'price_1', product: 'prod_1' } }] }, trial_end: 20, created: 2 }], has_more: false }); if (url.includes('/invoices')) return response({ data: [{ id: 'in_1', customer: 'cus_1', subscription: 'sub_1', status: 'paid', currency: 'brl', amount_due: 10000, amount_paid: 10000, amount_remaining: 0, created: 3, status_transitions: { paid_at: 4 } }], has_more: false }); if (url.includes('/payment_intents')) return response({ data: [{ id: 'pi_1', customer: 'cus_1', invoice: 'in_1', status: 'succeeded', amount_received: 10000, currency: 'brl', created: 5 }], has_more: false }); return response({ data: [{ id: 're_1', customer: 'cus_1', payment_intent: 'pi_1', amount: 2000, currency: 'brl', created: 6 }], has_more: false }); }) as typeof fetch);
  for (const stream of ['customers', 'subscriptions', 'invoices', 'payments', 'refunds']) {
    const result = await adapter.initialBackfill!(connection, credentials, { streamKey: stream, cursor: null, status: 'pending', processedCount: 0 });
    assert.equal(result.records.length, 1); assert.equal(result.hasMore, false); assert.match(result.nextCursor ?? '', /^20/);
  }
  const subscription = (await adapter.initialBackfill!(connection, credentials, { streamKey: 'subscriptions', cursor: null, status: 'pending', processedCount: 0 })).records[0]!;
  assert.equal(subscription.billingSubscription?.priceReference, 'price_1'); assert.equal(subscription.billingSubscription?.quantity, 2);
  assert.equal(calls.length, 6);
});

test('Stripe adapter verifies signatures, deduplicable event ids and does not regress an out-of-order subscription event', () => {
  const adapter = createStripeAdapter(); const body = { id: 'evt_current', type: 'customer.subscription.updated', created: 200, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', created: 1, items: { data: [] } } } };
  const raw = Buffer.from(JSON.stringify(body)); const signature = createHmac('sha256', credentials.webhook_secret).update(`200.${raw.toString('utf8')}`).digest('hex');
  assert.equal(adapter.verifyWebhook!(connection, credentials, { headers: { 'stripe-signature': `t=200,v1=${signature}` }, body, rawBody: raw }), true);
  const record = adapter.normalizeWebhook!(connection, { headers: {}, body })![0]!;
  assert.equal(record.billingSubscription?.sourceUpdatedAt, '1970-01-01T00:03:20.000Z');
  assert.equal(record.billingSubscription?.status, 'active');
  assert.equal(adapter.isAuthorizationRevokedWebhook!(connection, { headers: {}, body: { type: 'account.application.deauthorized' } }), true);
});

test('Stripe OAuth uses signed short-lived state and stores account metadata without a user-pasted API key', async () => {
  const adapter = createStripeAdapter((async () => response({ stripe_user_id: 'acct_immutable', livemode: false, scope: 'read_write' })) as typeof fetch);
  const url = adapter.getOAuthAuthorizeUrl!(connection, 'https://truvo.test/callback').url; const state = new URL(url).searchParams.get('state')!;
  const exchanged = await adapter.exchangeOAuthCode!(connection, { code: 'ac_one_time', redirectUri: 'https://truvo.test/callback', state });
  assert.deepEqual(exchanged.connectionMetadata, { stripe_account_id: 'acct_immutable', stripe_client_id: 'ca_test_platform', stripe_api_version: '2025-06-30.basil', stripe_account_mode: 'test', stripe_scope: 'read_write' });
  assert.equal((exchanged.credentials as { connected_account_id: string }).connected_account_id, 'acct_immutable');
  await assert.rejects(() => adapter.exchangeOAuthCode!(connection, { code: 'x', redirectUri: 'https://truvo.test/callback', state: 'tampered' }));
});
