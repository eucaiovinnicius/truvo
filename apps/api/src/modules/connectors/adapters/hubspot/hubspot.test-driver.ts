import { createHmac } from 'node:crypto';
import type { ConnectorTestDriver } from '../../testing/fake-provider.adapter';
import type { NormalizedRecord, RawWebhookRequest } from '../../contracts';
import type { HubspotFetch } from './hubspot.api-client';

/**
 * Order 061 (association + contract closure) — a deterministic HubSpot test
 * double implementing the SAME `ConnectorTestDriver` shape the fake provider
 * does, so the shared `connector-contract-kit.ts` proofs run against the REAL
 * `createHubspotAdapter()` unchanged (no HubSpot-only copy of the assertions).
 * No live HubSpot credentials/network — every response is scripted here.
 */

export type HubspotPullBehavior = 'success' | 'transient_error' | 'permanent_error' | 'rate_limited';

export interface HubspotDriverState {
  pullQueue: Response[];
  nextPullBehavior: HubspotPullBehavior;
  pullCallCount: number;
  nextWriteBehavior: 'success' | 'transient_error' | 'permanent_error';
  writeCallCount: number;
  validAccessToken: string;
  webhookSecret: string;
  pageSize: number;
  /** The exact URL the v3 webhook signature is computed over — must match what
   * `driver.webhookRequest()` puts in the returned request's `url` field. */
  webhookUrl: string;
}

export function createHubspotDriverState(overrides: Partial<HubspotDriverState> = {}): HubspotDriverState {
  return {
    pullQueue: [],
    nextPullBehavior: 'success',
    pullCallCount: 0,
    nextWriteBehavior: 'success',
    writeCallCount: 0,
    validAccessToken: 'contract_kit_valid_token',
    webhookSecret: 'contract_kit_webhook_secret',
    pageSize: 2,
    webhookUrl: 'https://truvo.example.com/v1/connectors/webhooks/contract-kit',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

export function createHubspotFetch(state: HubspotDriverState): HubspotFetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes('/oauth/v1/access-tokens/')) {
      const token = url.split('/').pop();
      if (token !== state.validAccessToken) return jsonResponse({}, 401);
      return jsonResponse({ scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read', 'crm.objects.contacts.write', 'crm.objects.deals.write'], hub_id: 1 });
    }
    if (url.includes('/oauth/v1/token')) {
      return jsonResponse({ access_token: state.validAccessToken, refresh_token: 'contract_kit_refresh', expires_in: 1800 });
    }

    const method = init?.method ?? 'GET';
    if (method === 'PATCH') {
      state.writeCallCount += 1;
      const behavior = state.nextWriteBehavior;
      state.nextWriteBehavior = 'success';
      if (behavior === 'transient_error') return jsonResponse({}, 500);
      if (behavior === 'permanent_error') return jsonResponse({ message: 'invalid property' }, 422);
      return jsonResponse({ id: 'contract_kit_write_result' });
    }

    if (url.includes('/search')) {
      state.pullCallCount += 1;
      const behavior = state.nextPullBehavior;
      state.nextPullBehavior = 'success';
      if (behavior === 'transient_error') return jsonResponse({}, 500);
      if (behavior === 'permanent_error') return jsonResponse({}, 401);
      if (behavior === 'rate_limited') return jsonResponse({ errorType: 'RATE_LIMIT' }, 429);
      return state.pullQueue.shift() ?? jsonResponse({ results: [] });
    }

    return jsonResponse({});
  }) as HubspotFetch;
}

const FAR_FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

export function createHubspotDriver(state: HubspotDriverState): ConnectorTestDriver {
  return {
    forceNextPull: (behavior) => {
      state.nextPullBehavior = behavior as HubspotPullBehavior;
    },
    forceNextWrite: (behavior) => {
      state.nextWriteBehavior = behavior;
    },
    seedCatalog: (records: NormalizedRecord[]) => {
      state.pullQueue = [];
      for (let i = 0; i < records.length; i += state.pageSize) {
        const chunk = records.slice(i, i + state.pageSize);
        const hasNext = i + state.pageSize < records.length;
        const nodes = chunk.map((r, idx) => ({
          id: r.identifiers[0]?.identifierValue ?? `contract_kit_${i}_${idx}`,
          properties: { hs_lastmodifieddate: String(Date.now()) },
        }));
        state.pullQueue.push(jsonResponse({ results: nodes, ...(hasNext ? { paging: { next: { after: `cursor_${i + state.pageSize}` } } } : {}) }));
      }
    },
    validCredentials: () => ({ access_token: state.validAccessToken, refresh_token: 'contract_kit_refresh', expires_at: FAR_FUTURE(), client_secret: state.webhookSecret }),
    invalidCredentials: () => ({ access_token: 'contract_kit_wrong_token', refresh_token: 'contract_kit_refresh', expires_at: FAR_FUTURE(), client_secret: state.webhookSecret }),
    webhookRequest: (customerRef, opts = {}): RawWebhookRequest => {
      const body = [{ subscriptionType: 'contact.propertyChange', objectId: customerRef, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }];
      const raw = Buffer.from(JSON.stringify(body));
      const timestamp = String(Date.now());
      const signature =
        opts.valid === false ? 'not_a_real_signature' : createHmac('sha256', state.webhookSecret).update(`POST${state.webhookUrl}${raw.toString('utf8')}${timestamp}`).digest('base64');
      return {
        headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
        body,
        rawBody: raw,
        url: state.webhookUrl,
        method: 'POST',
        deliveryId: opts.deliveryId,
      };
    },
    pullCallCount: () => state.pullCallCount,
    writeCallCount: () => state.writeCallCount,
    pageSize: () => state.pageSize,
    destinationWritePayload: () => ({ objectType: 'contacts', objectId: 'contract_kit_contact', property: 'truvo_propensity_band', value: 'high' }),
  };
}
