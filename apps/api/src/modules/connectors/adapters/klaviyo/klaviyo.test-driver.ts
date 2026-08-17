import type { ConnectorTestDriver } from '../../testing/fake-provider.adapter';
import type { NormalizedRecord, RawWebhookRequest } from '../../contracts';
import type { KlaviyoFetch } from './klaviyo.api-client';
import { KLAVIYO_API_BASE_URL } from './klaviyo.constants';

/**
 * Order 063 — a deterministic Klaviyo test double implementing the SAME
 * `ConnectorTestDriver` shape the fake provider/HubSpot/Stripe drivers do, so
 * the shared `connector-contract-kit.ts` proofs run against the REAL
 * `createKlaviyoAdapter()` unchanged (no Klaviyo-only copy of the assertions).
 * No live Klaviyo credentials/network — every response is scripted here.
 *
 * Klaviyo declares NO `webhook_ingest` capability (see `klaviyo.adapter.ts`),
 * so `webhookRequest()` throws — mirrored on `klaviyo.contract-kit.test.ts`,
 * which never calls `proveDuplicateWebhookIsHarmless`/
 * `proveInvalidWebhookSignatureRejected` for this provider (kept only to
 * satisfy `ConnectorTestDriver`'s shape, same as Stripe's driver keeping
 * `forceNextWrite`/`writeCallCount`/`destinationWritePayload` even where unused).
 */

export type KlaviyoPullBehavior = 'success' | 'transient_error' | 'permanent_error' | 'rate_limited';

export interface KlaviyoDriverState {
  /** Any pull (backfill/incremental, either stream) is served from this single
   * queue, shifted in call order — mirrors `hubspot.test-driver.ts`'s `pullQueue`. */
  pullQueue: Response[];
  nextPullBehavior: KlaviyoPullBehavior;
  pullCallCount: number;
  nextWriteBehavior: 'success' | 'transient_error' | 'permanent_error';
  writeCallCount: number;
  validAccessToken: string;
  accountId: string;
  pageSize: number;
}

export function createKlaviyoDriverState(overrides: Partial<KlaviyoDriverState> = {}): KlaviyoDriverState {
  return {
    pullQueue: [],
    nextPullBehavior: 'success',
    pullCallCount: 0,
    nextWriteBehavior: 'success',
    writeCallCount: 0,
    validAccessToken: 'contract_kit_valid_klaviyo_token',
    accountId: 'contract_kit_klaviyo_account',
    pageSize: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? headers[key] ?? null },
    json: async () => body,
  } as unknown as Response;
}

export function createKlaviyoFetch(state: KlaviyoDriverState): KlaviyoFetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';

    if (url.includes('/oauth/token')) {
      return jsonResponse({ access_token: state.validAccessToken, refresh_token: 'contract_kit_klaviyo_refresh', expires_in: 3600, token_type: 'Bearer' });
    }

    if (url.includes('/api/accounts')) {
      if (headers.Authorization !== `Bearer ${state.validAccessToken}`) return jsonResponse({}, 401);
      return jsonResponse({ data: [{ id: state.accountId, attributes: {} }] });
    }

    if (method === 'PATCH') {
      state.writeCallCount += 1;
      const behavior = state.nextWriteBehavior;
      state.nextWriteBehavior = 'success';
      if (behavior === 'transient_error') return jsonResponse({}, 500);
      if (behavior === 'permanent_error') return jsonResponse({}, 422);
      return jsonResponse({ data: { id: 'contract_kit_write_result' } });
    }

    if (method === 'POST' && url.includes('/api/events')) {
      state.writeCallCount += 1;
      const behavior = state.nextWriteBehavior;
      state.nextWriteBehavior = 'success';
      if (behavior === 'transient_error') return jsonResponse({}, 500);
      if (behavior === 'permanent_error') return jsonResponse({}, 400);
      return jsonResponse(undefined, 202);
    }

    // Any other call is a profiles/events pull (both streams share this queue).
    state.pullCallCount += 1;
    const behavior = state.nextPullBehavior;
    state.nextPullBehavior = 'success';
    if (behavior === 'transient_error') return jsonResponse({}, 500);
    if (behavior === 'permanent_error') return jsonResponse({}, 401);
    if (behavior === 'rate_limited') return jsonResponse({}, 429, { 'retry-after': '0' });
    return state.pullQueue.shift() ?? jsonResponse({ data: [], links: { next: null } });
  }) as KlaviyoFetch;
}

const FAR_FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

export function createKlaviyoDriver(state: KlaviyoDriverState): ConnectorTestDriver {
  return {
    forceNextPull: (behavior) => {
      state.nextPullBehavior = behavior as KlaviyoPullBehavior;
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
          attributes: { updated: new Date().toISOString() },
        }));
        state.pullQueue.push(
          jsonResponse({
            data: nodes,
            links: { next: hasNext ? `${KLAVIYO_API_BASE_URL}/api/profiles?page[cursor]=cursor_${i + state.pageSize}` : null },
          }),
        );
      }
    },
    validCredentials: () => ({ access_token: state.validAccessToken, refresh_token: 'contract_kit_klaviyo_refresh', expires_at: FAR_FUTURE(), klaviyo_account_id: state.accountId }),
    invalidCredentials: () => ({ access_token: 'contract_kit_wrong_klaviyo_token', refresh_token: 'contract_kit_klaviyo_refresh', expires_at: FAR_FUTURE(), klaviyo_account_id: state.accountId }),
    webhookRequest: (): RawWebhookRequest => {
      throw new Error('Klaviyo declares no webhook_ingest capability — verifyWebhook/normalizeWebhook are intentionally unimplemented (see klaviyo.adapter.ts)');
    },
    pullCallCount: () => state.pullCallCount,
    writeCallCount: () => state.writeCallCount,
    pageSize: () => state.pageSize,
    destinationWritePayload: () => ({ profileId: 'contract_kit_profile', properties: { truvo_score_band: 'high' } }),
  };
}
