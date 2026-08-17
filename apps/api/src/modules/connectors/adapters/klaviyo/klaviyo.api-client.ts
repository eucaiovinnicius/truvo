import { KLAVIYO_API_BASE_URL, KLAVIYO_API_REVISION } from './klaviyo.constants';

/**
 * Order 063 §1 — minimal fetch-based Klaviyo REST client: Bearer OAuth auth +
 * the pinned `revision` header on every request. Mirrors `stripe.api-client.ts`'s
 * shape (a single `request<T>()` wrapper, errors thrown as
 * `Object.assign(new Error(...), { status })` — the SAME convention
 * `classifyFailure` (`@truvo/observability`) and the orchestrator's retry/backoff
 * already understand). No proactive token-refresh logic here, deliberately —
 * Stripe's client does not refresh either (it uses a static platform key); a
 * Klaviyo access token nearing/at expiry surfaces as a 401, classified as an
 * `authFailure` exactly like every other provider's expired/invalid credential
 * (see `klaviyo.adapter.ts#testConnection`). `fetchImpl` is injectable so
 * adapter/unit tests run against a deterministic double — no real Klaviyo
 * credentials/network needed.
 *
 * `request()` accepts EITHER a path (prefixed with `KLAVIYO_API_BASE_URL`) OR a
 * fully-qualified URL as-is — the latter lets pagination follow Klaviyo's own
 * `links.next` URL literally (Klaviyo's cursor pagination is `page[cursor]`
 * request-side, `links.next` response-side — an opaque full URL, not a bare
 * token like Stripe's `starting_after`).
 */

export type KlaviyoFetch = typeof fetch;

export interface KlaviyoCredentials {
  access_token: string;
  refresh_token?: string;
  /** ISO timestamp — informational only (no proactive refresh implemented here). */
  expires_at?: string;
  klaviyo_account_id?: string;
}

export class KlaviyoApiClient {
  constructor(
    private readonly credentials: KlaviyoCredentials,
    private readonly fetchImpl: KlaviyoFetch = fetch,
  ) {}

  async request<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
    if (!this.credentials.access_token) {
      throw Object.assign(new Error('Klaviyo access token missing'), { status: 401 });
    }
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${KLAVIYO_API_BASE_URL}${pathOrUrl}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.credentials.access_token}`,
        revision: KLAVIYO_API_REVISION,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`klaviyo authorization failure (${response.status})`), { status: response.status });
    }
    if (response.status === 429) {
      throw Object.assign(new Error('klaviyo rate limited'), { status: 429, retryAfterMs: Number(response.headers.get('retry-after') ?? 2) * 1000 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`klaviyo http error (${response.status})`), { status: response.status });
    }
    // Create Event (POST /api/events) returns 202 Accepted with no reliable body
    // (Order 063 §6 — "accepted/submitted, not confirmed"); DELETE-shaped 204s
    // are the other no-body case. Never attempt `.json()` on either.
    if (response.status === 202 || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(pathOrUrl: string): Promise<T> {
    return this.request<T>(pathOrUrl, { method: 'GET' });
  }

  post<T>(pathOrUrl: string, body: unknown): Promise<T> {
    return this.request<T>(pathOrUrl, { method: 'POST', body: JSON.stringify(body) });
  }

  patch<T>(pathOrUrl: string, body: unknown): Promise<T> {
    return this.request<T>(pathOrUrl, { method: 'PATCH', body: JSON.stringify(body) });
  }
}
