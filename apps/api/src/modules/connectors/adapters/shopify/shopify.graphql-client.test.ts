import assert from 'node:assert/strict';
import test from 'node:test';
import { SHOPIFY_API_VERSION } from './shopify.constants';
import { ShopifyGraphQLClient, type ShopifyFetch } from './shopify.graphql-client';

/** Order 060 — GraphQL client failure classification against a deterministic fake
 * fetch (no real Shopify credentials/network involved). Mirrors the SAME
 * `Object.assign(new Error(...), { status })` convention `classifyFailure`
 * (`@truvo/observability`) and the orchestrator already understand. */

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const CREDS = { shop_domain: 'test-shop.myshopify.com', access_token: 'shpat_test' };

test('pins the request URL to the exact declared SHOPIFY_API_VERSION', async () => {
  let capturedUrl = '';
  const fetchImpl: ShopifyFetch = (async (url: string) => {
    capturedUrl = url;
    return fakeResponse(200, { data: { ok: true } });
  }) as ShopifyFetch;
  const client = new ShopifyGraphQLClient(CREDS, fetchImpl);
  await client.request('query { ok }');
  assert.ok(capturedUrl.includes(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`));
});

test('HTTP 429 → transient with retryAfterMs from the Retry-After header', async () => {
  const fetchImpl: ShopifyFetch = (async () => fakeResponse(429, {}, { 'retry-after': '3' })) as ShopifyFetch;
  const client = new ShopifyGraphQLClient(CREDS, fetchImpl);
  await assert.rejects(client.request('query { ok }'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 429);
    assert.equal((err as { retryAfterMs?: number }).retryAfterMs, 3000);
    return true;
  });
});

test('GraphQL-level THROTTLED error is reclassified as a 429-equivalent transient failure', async () => {
  const fetchImpl: ShopifyFetch = (async () =>
    fakeResponse(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })) as ShopifyFetch;
  const client = new ShopifyGraphQLClient(CREDS, fetchImpl);
  await assert.rejects(client.request('query { ok }'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 429);
    return true;
  });
});

test('HTTP 401/403 → permanent auth failure (adapter maps this to authFailure)', async () => {
  const fetchImpl401: ShopifyFetch = (async () => fakeResponse(401, {})) as ShopifyFetch;
  const client401 = new ShopifyGraphQLClient(CREDS, fetchImpl401);
  await assert.rejects(client401.request('query { ok }'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 401);
    return true;
  });

  const fetchImpl403: ShopifyFetch = (async () => fakeResponse(403, {})) as ShopifyFetch;
  const client403 = new ShopifyGraphQLClient(CREDS, fetchImpl403);
  await assert.rejects(client403.request('query { ok }'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 403);
    return true;
  });
});

test('non-throttled GraphQL errors surface as a permanent (non-retryable) failure', async () => {
  const fetchImpl: ShopifyFetch = (async () => fakeResponse(200, { errors: [{ message: 'Field does not exist' }] })) as ShopifyFetch;
  const client = new ShopifyGraphQLClient(CREDS, fetchImpl);
  await assert.rejects(client.request('query { ok }'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 400);
    return true;
  });
});

test('successful response returns the data payload', async () => {
  const fetchImpl: ShopifyFetch = (async () => fakeResponse(200, { data: { widgets: 3 } })) as ShopifyFetch;
  const client = new ShopifyGraphQLClient(CREDS, fetchImpl);
  const data = await client.request<{ widgets: number }>('query { widgets }');
  assert.equal(data.widgets, 3);
});
