import { HUBSPOT_API_BASE_URL, HUBSPOT_OAUTH_TOKEN_URL } from './hubspot.constants';

/**
 * Order 061 §1 — minimal fetch-based HubSpot CRM REST client with OAuth token
 * refresh. Errors are thrown as `Object.assign(new Error(...), { status })` — the
 * SAME convention `classifyFailure` (`@truvo/observability`) and the orchestrator's
 * retry/backoff already understand (mirrors `shopify.graphql-client.ts`). 429 is
 * HubSpot's confirmed rate-limit signal (no reliable Retry-After header per
 * HubSpot's own usage-guidelines docs — exponential backoff is used instead, same
 * as the orchestrator already does for any 429). `fetchImpl` is injectable so
 * adapter/unit tests run against a deterministic double — no real HubSpot
 * credentials needed.
 */

export interface HubspotCredentials {
  access_token: string;
  refresh_token: string;
  /** ISO timestamp — access tokens are short-lived (~30 min); refreshed proactively. */
  expires_at: string;
  portal_id?: string;
}

export type HubspotFetch = typeof fetch;

const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 2000;

export class HubspotApiClient {
  private credentials: HubspotCredentials;

  constructor(
    credentials: HubspotCredentials,
    private readonly fetchImpl: HubspotFetch = fetch,
    /** Called whenever a refresh mints a new access_token — the caller persists it
     * via the SAME `ConnectorConnectionService.setCredentials` every provider uses. */
    private readonly onTokenRefreshed?: (credentials: HubspotCredentials) => void,
  ) {
    this.credentials = credentials;
  }

  private async ensureFreshToken(): Promise<void> {
    const expiresAt = Date.parse(this.credentials.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS) return;

    const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET ?? '';
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: this.credentials.refresh_token,
    });
    const response = await this.fetchImpl(HUBSPOT_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`hubspot token refresh auth failure (${response.status})`), { status: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`hubspot token refresh failed (${response.status})`), { status: response.status });
    }
    const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    this.credentials = {
      ...this.credentials,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? this.credentials.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };
    this.onTokenRefreshed?.(this.credentials);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureFreshToken();
    const response = await this.fetchImpl(`${HUBSPOT_API_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.credentials.access_token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`hubspot auth failure (${response.status})`), { status: response.status });
    }
    if (response.status === 429) {
      throw Object.assign(new Error('hubspot rate limited'), { status: 429, retryAfterMs: DEFAULT_RETRY_AFTER_MS });
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw Object.assign(new Error(`hubspot http error (${response.status}): ${(errorBody as { message?: string }).message ?? 'unknown'}`), { status: response.status });
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /** `GET /oauth/v1/access-tokens/{token}` — introspects the CURRENT token's
   * granted scopes, mirroring Shopify's `currentAppInstallation.accessScopes`
   * pattern for `testConnection`'s least-privilege check. */
  async getGrantedScopes(): Promise<string[]> {
    await this.ensureFreshToken();
    // The access-tokens introspection endpoint takes the token itself as a path
    // segment (not an Authorization header) — a raw fetch, not `request()`.
    const response = await this.fetchImpl(`${HUBSPOT_API_BASE_URL}/oauth/v1/access-tokens/${this.credentials.access_token}`, { method: 'GET' });
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`hubspot auth failure (${response.status})`), { status: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`hubspot http error (${response.status})`), { status: response.status });
    }
    const data = (await response.json()) as { scopes: string[]; hub_id: number };
    return data.scopes;
  }

  currentCredentials(): HubspotCredentials {
    return this.credentials;
  }
}
