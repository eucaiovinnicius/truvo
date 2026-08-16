import assert from 'node:assert/strict';
import test from 'node:test';
import { HubspotApiClient, type HubspotCredentials, type HubspotFetch } from './hubspot.api-client';

/** Order 061 — API client proofs against a deterministic fake fetch: token
 * refresh (proactive + on-401), 429 classification, and error propagation. No
 * real HubSpot credentials/network involved. */

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

const FRESH: HubspotCredentials = { access_token: 'tok_fresh', refresh_token: 'refresh_1', expires_at: new Date(Date.now() + 3600_000).toISOString() };
const EXPIRED: HubspotCredentials = { access_token: 'tok_old', refresh_token: 'refresh_1', expires_at: new Date(Date.now() - 1000).toISOString() };

test('a fresh token is used as-is — no refresh call made', async () => {
  const calls: string[] = [];
  const fetchImpl: HubspotFetch = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ ok: true });
  }) as HubspotFetch;
  const client = new HubspotApiClient(FRESH, fetchImpl);
  await client.get('/crm/objects/2026-03/contacts/1');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.includes('oauth'), 'no refresh call for an already-fresh token');
});

test('an expired token is refreshed BEFORE the actual request, and the new token is used', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl: HubspotFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
    if (url.includes('/oauth/v1/token')) return jsonResponse({ access_token: 'tok_new', refresh_token: 'refresh_2', expires_in: 1800 });
    return jsonResponse({ ok: true });
  }) as HubspotFetch;

  let refreshedTo: HubspotCredentials | undefined;
  const client = new HubspotApiClient(EXPIRED, fetchImpl, (creds) => { refreshedTo = creds; });
  await client.get('/crm/objects/2026-03/contacts/1');

  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.includes('/oauth/v1/token'), 'refresh happens first');
  assert.equal(calls[1]!.headers?.Authorization, 'Bearer tok_new', 'the actual request uses the NEW token');
  assert.equal(refreshedTo?.access_token, 'tok_new');
  assert.equal(refreshedTo?.refresh_token, 'refresh_2');
});

test('HTTP 429 → transient, classifiable failure', async () => {
  const fetchImpl: HubspotFetch = (async () => jsonResponse({ errorType: 'RATE_LIMIT' }, 429)) as HubspotFetch;
  const client = new HubspotApiClient(FRESH, fetchImpl);
  await assert.rejects(client.get('/crm/objects/2026-03/contacts/1'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 429);
    return true;
  });
});

test('HTTP 401/403 → permanent auth failure', async () => {
  const fetchImpl401: HubspotFetch = (async () => jsonResponse({}, 401)) as HubspotFetch;
  const client401 = new HubspotApiClient(FRESH, fetchImpl401);
  await assert.rejects(client401.get('/crm/objects/2026-03/contacts/1'), (err: unknown) => {
    assert.equal((err as { status?: number }).status, 401);
    return true;
  });
});

test('getGrantedScopes: returns the scopes array from the access-token introspection endpoint', async () => {
  const fetchImpl: HubspotFetch = (async (url: string) => {
    assert.ok(url.includes('/oauth/v1/access-tokens/'));
    return jsonResponse({ scopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'], hub_id: 123 });
  }) as HubspotFetch;
  const client = new HubspotApiClient(FRESH, fetchImpl);
  const scopes = await client.getGrantedScopes();
  assert.deepEqual(scopes, ['crm.objects.contacts.read', 'crm.objects.deals.read']);
});

test('missing property error surfaces the response message', async () => {
  const fetchImpl: HubspotFetch = (async () => jsonResponse({ message: "Property \"nonexistent_prop\" does not exist" }, 400)) as HubspotFetch;
  const client = new HubspotApiClient(FRESH, fetchImpl);
  await assert.rejects(client.patch('/crm/objects/2026-03/contacts/1', { properties: { nonexistent_prop: 'x' } }), (err: unknown) => {
    assert.match((err as Error).message, /nonexistent_prop/);
    return true;
  });
});
