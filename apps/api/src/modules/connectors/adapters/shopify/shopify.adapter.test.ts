import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import type { ConnectorConnection } from '../../contracts';
import { SHOPIFY_REQUIRED_SCOPES } from './shopify.constants';
import { createShopifyAdapter } from './shopify.adapter';
import type { ShopifyFetch } from './shopify.graphql-client';

/** Order 060 — adapter-level proofs against a deterministic fake fetch: scope
 * checking, webhook signature verification/dispatch, and cursor pagination. No
 * DB/network involved — the real-Postgres end-to-end proof lives in
 * `shopify.adapter.contract.test.ts`. */

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    workspaceId: 'ws_test',
    id: 'conn_test',
    provider: 'shopify',
    role: 'source',
    displayName: 'Test Shop',
    lifecycleState: 'connected',
    credentialStatus: 'valid',
    config: { shop_domain: 'test-shop.myshopify.com' },
    capabilities: [],
    lastError: null,
    lastCredentialCheckAt: null,
    lastSyncAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

test('testConnection: all required scopes granted → ok', async () => {
  const fetchImpl: ShopifyFetch = (async () =>
    jsonResponse({ data: { currentAppInstallation: { accessScopes: SHOPIFY_REQUIRED_SCOPES.map((h) => ({ handle: h })) } } })) as ShopifyFetch;
  const adapter = createShopifyAdapter(fetchImpl);
  const result = await adapter.testConnection(connection(), { access_token: 'shpat_x' });
  assert.equal(result.ok, true);
  assert.equal(result.credentialStatus, 'valid');
});

test('testConnection: missing a required scope → fails closed with which scope is missing', async () => {
  const fetchImpl: ShopifyFetch = (async () =>
    jsonResponse({ data: { currentAppInstallation: { accessScopes: [{ handle: 'read_customers' }] } } })) as ShopifyFetch;
  const adapter = createShopifyAdapter(fetchImpl);
  const result = await adapter.testConnection(connection(), { access_token: 'shpat_x' });
  assert.equal(result.ok, false);
  assert.match(result.message, /read_orders/);
});

test('testConnection: 401 from Shopify → authFailure, distinct from a generic failure', async () => {
  const fetchImpl: ShopifyFetch = (async () => jsonResponse({}, 401)) as ShopifyFetch;
  const adapter = createShopifyAdapter(fetchImpl);
  const result = await adapter.testConnection(connection(), { access_token: 'shpat_bad' });
  assert.equal(result.ok, false);
  assert.equal(result.authFailure, true);
});

test('testConnection: missing shop_domain/access_token fails locally, never calls fetch', async () => {
  let called = false;
  const fetchImpl: ShopifyFetch = (async () => {
    called = true;
    return jsonResponse({});
  }) as ShopifyFetch;
  const adapter = createShopifyAdapter(fetchImpl);
  const result = await adapter.testConnection(connection({ config: {} }), {});
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('initialBackfill: paginates via cursor, hasNextPage drives continuation', async () => {
  let call = 0;
  const fetchImpl: ShopifyFetch = (async () => {
    call += 1;
    if (call === 1) {
      return jsonResponse({
        data: {
          orders: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor_1' },
            nodes: [orderNode('1')],
          },
        },
      });
    }
    return jsonResponse({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [orderNode('2')] } } });
  }) as ShopifyFetch;

  const adapter = createShopifyAdapter(fetchImpl);
  const conn = connection();
  const creds = { access_token: 'shpat_x' };

  const first = await adapter.initialBackfill!(conn, creds, { streamKey: 'default', cursor: null, status: 'pending', processedCount: 0 });
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, 'cursor_1');
  assert.equal(first.records.length, 1);

  const second = await adapter.initialBackfill!(conn, creds, { streamKey: 'default', cursor: 'cursor_1', status: 'running', processedCount: 1 });
  assert.equal(second.hasMore, false);
  assert.equal(second.records.length, 1);
});

function orderNode(id: string) {
  return {
    id: `gid://shopify/Order/${id}`,
    displayFinancialStatus: 'PAID',
    processedAt: '2026-08-01T00:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'BRL' } },
    customer: null,
    lineItems: { nodes: [] },
    refunds: [],
  };
}

test('verifyWebhook: valid HMAC accepted, tampered body rejected (fails closed)', () => {
  const adapter = createShopifyAdapter((async () => jsonResponse({})) as ShopifyFetch);
  const secret = 'wh_secret';
  const raw = Buffer.from(JSON.stringify({ id: 1 }));
  const signature = createHmac('sha256', secret).update(raw).digest('base64');

  const validReq = { headers: { 'x-shopify-hmac-sha256': signature }, rawBody: raw, body: JSON.parse(raw.toString()) };
  assert.equal(adapter.verifyWebhook!(connection(), { webhook_secret: secret }, validReq), true);

  const tamperedRaw = Buffer.from(JSON.stringify({ id: 2 }));
  const tamperedReq = { headers: { 'x-shopify-hmac-sha256': signature }, rawBody: tamperedRaw, body: JSON.parse(tamperedRaw.toString()) };
  assert.equal(adapter.verifyWebhook!(connection(), { webhook_secret: secret }, tamperedReq), false);
});

test('normalizeWebhook: unknown topic → null (ignored, not an error)', () => {
  const adapter = createShopifyAdapter((async () => jsonResponse({})) as ShopifyFetch);
  const result = adapter.normalizeWebhook!(connection(), { headers: { 'x-shopify-topic': 'shop/redact' }, body: {} });
  assert.equal(result, null);
});

test('normalizeWebhook: orders/paid dispatches to the order mapper', () => {
  const adapter = createShopifyAdapter((async () => jsonResponse({})) as ShopifyFetch);
  const body = { id: 1001, financial_status: 'paid', processed_at: '2026-08-01T00:00:00Z', total_price: '10.00', currency: 'BRL', line_items: [] };
  const result = adapter.normalizeWebhook!(connection(), { headers: { 'x-shopify-topic': 'orders/paid' }, body });
  assert.equal(result?.length, 1);
  assert.equal(result![0]!.commerceOrder!.financialStatus, 'paid');
});

test('normalizeWebhook: refunds/create dispatches to the refund mapper', () => {
  const adapter = createShopifyAdapter((async () => jsonResponse({})) as ShopifyFetch);
  const body = { id: '9', order_id: '1001', created_at: '2026-08-02T00:00:00Z', transactions: [{ amount: '5.00', currency: 'BRL' }] };
  const result = adapter.normalizeWebhook!(connection(), { headers: { 'x-shopify-topic': 'refunds/create' }, body });
  assert.equal(result?.length, 1);
  assert.equal(result![0]!.commerceOrder!.refunds![0]!.amount, 5);
});
