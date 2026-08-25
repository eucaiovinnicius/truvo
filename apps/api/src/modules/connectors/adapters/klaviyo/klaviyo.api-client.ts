import { KLAVIYO_API_BASE_URL, KLAVIYO_API_REVISION, KLAVIYO_OAUTH_TOKEN_URL } from './klaviyo.constants';

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

const REFRESH_MARGIN_MS = 60_000;

export function shouldRefreshKlaviyoCredentials(credentials: KlaviyoCredentials, now = Date.now()): boolean {
  if (!credentials.access_token || !credentials.refresh_token) return false;
  const expiresAt = Date.parse(credentials.expires_at ?? '');
  return Number.isFinite(expiresAt) && expiresAt - now <= REFRESH_MARGIN_MS;
}

/** Provider-only refresh grant. Durable encrypted persistence and concurrency
 * control are deliberately owned by ConnectorConnectionService. */
export async function refreshKlaviyoCredentials(credentials: KlaviyoCredentials, fetchImpl: KlaviyoFetch = fetch): Promise<KlaviyoCredentials> {
  if (!credentials.refresh_token) {
    throw Object.assign(new Error('klaviyo oauth refresh requires a refresh token'), { status: 401, reauthorizationRequired: true });
  }
  const clientId = process.env.KLAVIYO_CLIENT_ID ?? '';
  const clientSecret = process.env.KLAVIYO_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('Klaviyo OAuth client credentials are required for token refresh'), { status: 500 });
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetchImpl(KLAVIYO_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(`klaviyo oauth refresh reauthorization required (${response.status})`), { status: response.status, reauthorizationRequired: true });
  }
  if (!response.ok) throw Object.assign(new Error(`klaviyo oauth refresh failed (${response.status})`), { status: response.status });
  const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw Object.assign(new Error('klaviyo oauth refresh response missing rotated token material'), { status: 502 });
  }
  const expiresIn = data.expires_in!;
  return {
    ...credentials,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
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
