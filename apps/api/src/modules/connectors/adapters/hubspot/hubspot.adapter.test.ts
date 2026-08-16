import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import type { ConnectorConnection } from '../../contracts';
import { createHubspotAdapter } from './hubspot.adapter';
import type { HubspotFetch } from './hubspot.api-client';

/** Order 061 §6 — adapter-level proofs against a deterministic fake fetch. The
 * critical proof here is the KNOWN BATCH BUG fix: the legacy M4 normalizer only
 * reads the first event of a HubSpot webhook batch; this adapter's
 * `normalizeWebhook` must process EVERY event. No DB/network involved — the
 * real-Postgres end-to-end proof lives in `hubspot.adapter.contract.test.ts`. */

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    workspaceId: 'ws_test', id: 'conn_test', provider: 'hubspot', role: 'bidirectional',
    displayName: 'Test Portal', lifecycleState: 'connected', credentialStatus: 'valid',
    config: { object_selection: { contacts: { enabled: true, properties: ['lifecyclestage'] }, companies: { enabled: true, properties: [] }, deals: { enabled: true, properties: [] } } },
    capabilities: [], lastError: null, lastCredentialCheckAt: null, lastSyncAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

test('normalizeWebhook: a batch of 3 events produces 3 normalized records — THE fix for the known single-event bug', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const body = [
    { eventId: 1, subscriptionType: 'contact.propertyChange', objectId: '2001', propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: 1735689600000 },
    { eventId: 2, subscriptionType: 'contact.propertyChange', objectId: '2002', propertyName: 'lifecyclestage', propertyValue: 'customer', occurredAt: 1735689600001 },
    { eventId: 3, subscriptionType: 'contact.propertyChange', objectId: '2003', propertyName: 'lifecyclestage', propertyValue: 'opportunity', occurredAt: 1735689600002 },
  ];
  const result = adapter.normalizeWebhook!(connection(), { headers: {}, body });
  assert.equal(result?.length, 3, 'every event in the batch must be normalized, not just the first');
  const objectIds = result!.map((r) => r.identifiers[0]!.identifierValue).sort();
  assert.deepEqual(objectIds, ['2001', '2002', '2003']);
});

test('normalizeWebhook: one malformed event in the batch does not discard the rest', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const body = [
    { eventId: 1, subscriptionType: 'contact.propertyChange', objectId: '2001', propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: 1 },
    { eventId: 2, subscriptionType: 'contact.propertyChange' /* missing objectId — malformed */ },
    { eventId: 3, subscriptionType: 'contact.propertyChange', objectId: '2003', propertyName: 'lifecyclestage', propertyValue: 'opportunity', occurredAt: 3 },
  ];
  const result = adapter.normalizeWebhook!(connection(), { headers: {}, body });
  assert.equal(result?.length, 2, 'the malformed event is skipped; the other two still process');
});

test('normalizeWebhook: mixed contact/company/deal batch dispatches each to its own mapper', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const body = [
    { subscriptionType: 'contact.propertyChange', objectId: '2001', propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: 1 },
    { subscriptionType: 'company.propertyChange', objectId: '9001', propertyName: 'industry', propertyValue: 'software', occurredAt: 2 },
    { subscriptionType: 'deal.propertyChange', objectId: '5001', propertyName: 'dealstage', propertyValue: 'closedwon', occurredAt: 3 },
  ];
  const result = adapter.normalizeWebhook!(connection(), { headers: {}, body });
  assert.equal(result?.length, 3);
  assert.ok(result!.some((r) => r.identifiers.length > 0), 'contact event carries an identifier');
  assert.ok(result!.some((r) => r.crmAccount), 'company event carries a crmAccount');
  assert.ok(result!.some((r) => r.crmDeal), 'deal event carries a crmDeal');
});

test('normalizeWebhook: an object type disabled in config is silently skipped, not an error', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const conn = connection({ config: { object_selection: { contacts: { enabled: true, properties: [] }, companies: { enabled: false, properties: [] } } } });
  const body = [{ subscriptionType: 'company.propertyChange', objectId: '9001', propertyName: 'industry', propertyValue: 'software', occurredAt: 1 }];
  const result = adapter.normalizeWebhook!(conn, { headers: {}, body });
  assert.equal(result, null);
});

test('normalizeWebhook: non-array body → null (ignored, not an error)', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const result = adapter.normalizeWebhook!(connection(), { headers: {}, body: { not: 'an array' } });
  assert.equal(result, null);
});

test('testConnection: all required scopes granted → ok; missing scope fails closed', async () => {
  const grantedAll: HubspotFetch = (async () => jsonResponse({ scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'] })) as HubspotFetch;
  const adapterAll = createHubspotAdapter(grantedAll);
  const okResult = await adapterAll.testConnection(connection(), { access_token: 'tok', refresh_token: 'rt', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(okResult.ok, true);

  const grantedPartial: HubspotFetch = (async () => jsonResponse({ scopes: ['crm.objects.contacts.read'] })) as HubspotFetch;
  const adapterPartial = createHubspotAdapter(grantedPartial);
  const badResult = await adapterPartial.testConnection(connection(), { access_token: 'tok', refresh_token: 'rt', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(badResult.ok, false);
  assert.match(badResult.message, /companies|deals/);
});

test('testConnection: 401 → authFailure', async () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({}, 401)) as HubspotFetch);
  const result = await adapter.testConnection(connection(), { access_token: 'tok', refresh_token: 'rt', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(result.ok, false);
  assert.equal(result.authFailure, true);
});

test('verifyWebhook: valid v3 signature accepted, tampered body rejected', () => {
  const adapter = createHubspotAdapter((async () => jsonResponse({})) as HubspotFetch);
  const secret = 'hubspot_client_secret';
  const raw = Buffer.from(JSON.stringify([{ eventId: 1 }]));
  const url = 'https://truvo.example.com/v1/connectors/webhooks/ws_test/conn_test';
  const timestamp = String(Date.now());
  const base = `POST${url}${raw.toString('utf8')}${timestamp}`;
  const signature = createHmac('sha256', secret).update(base).digest('base64');

  const validReq = { headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp }, rawBody: raw, body: JSON.parse(raw.toString()), url, method: 'POST' };
  assert.equal(adapter.verifyWebhook!(connection(), { client_secret: secret }, validReq), true);

  const tamperedRaw = Buffer.from(JSON.stringify([{ eventId: 2 }]));
  const tamperedReq = { ...validReq, rawBody: tamperedRaw, body: JSON.parse(tamperedRaw.toString()) };
  assert.equal(adapter.verifyWebhook!(connection(), { client_secret: secret }, tamperedReq), false);
});

test('write (writeback): only namespaced truvo_* properties are accepted', async () => {
  let patchedProperties: Record<string, unknown> | undefined;
  const fetchImpl: HubspotFetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patchedProperties = (JSON.parse(init.body as string) as { properties: Record<string, unknown> }).properties;
      return jsonResponse({ id: '2001' });
    }
    return jsonResponse({});
  }) as HubspotFetch;
  const adapter = createHubspotAdapter(fetchImpl);
  const creds = { access_token: 'tok', refresh_token: 'rt', expires_at: new Date(Date.now() + 3600_000).toISOString() };

  const rejected = await adapter.write(connection(), creds, { idempotencyKey: 'k1', correlationId: 'c1', kind: 'profile_upsert', payload: { objectId: '2001', property: 'first_name', value: 'hacked' } });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.retryable, false);

  const accepted = await adapter.write(connection(), creds, { idempotencyKey: 'k2', correlationId: 'c2', kind: 'profile_upsert', payload: { objectId: '2001', property: 'truvo_propensity_band', value: 'high' } });
  assert.equal(accepted.status, 'sent');
  assert.deepEqual(patchedProperties, { truvo_propensity_band: 'high' });
});
