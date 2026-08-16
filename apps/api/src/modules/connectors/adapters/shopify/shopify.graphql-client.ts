import { SHOPIFY_API_VERSION } from './shopify.constants';

/**
 * Order 060 §1/§3 — minimal fetch-based Shopify Admin GraphQL client.
 *
 * Errors are thrown as `Object.assign(new Error(...), { status })` — the SAME
 * convention `classifyFailure` (`@truvo/observability`) and the orchestrator's
 * retry/backoff already understand (see `testing/fake-provider.adapter.ts` for the
 * pattern this mirrors). 429 and GraphQL-level `THROTTLED` errors both become a 429
 * so a single classifier handles both transports Shopify uses to signal throttling.
 * 401/403 become permanent+auth failures. `fetchImpl` is injectable so adapter/unit
 * tests run against a deterministic double — no real Shopify credentials needed.
 */

export interface ShopifyCredentials {
  shop_domain: string;
  access_token: string;
}

export type ShopifyFetch = typeof fetch;

export interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

const DEFAULT_RETRY_AFTER_MS = 2000;

export class ShopifyGraphQLClient {
  constructor(
    private readonly credentials: ShopifyCredentials,
    private readonly fetchImpl: ShopifyFetch = fetch,
  ) {}

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.credentials.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.credentials.access_token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`shopify auth failure (${response.status})`), { status: response.status });
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : DEFAULT_RETRY_AFTER_MS;
      throw Object.assign(new Error('shopify rate limited'), { status: 429, retryAfterMs });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`shopify http error (${response.status})`), { status: response.status });
    }

    const body = (await response.json()) as ShopifyGraphQLResponse<T>;
    const throttled = body.errors?.find((e) => e.extensions?.code === 'THROTTLED');
    if (throttled) {
      throw Object.assign(new Error('shopify graphql THROTTLED'), { status: 429, retryAfterMs: DEFAULT_RETRY_AFTER_MS });
    }
    if (body.errors && body.errors.length > 0) {
      throw Object.assign(new Error(`shopify graphql error: ${body.errors.map((e) => e.message).join('; ')}`), { status: 400 });
    }
    if (!body.data) {
      throw Object.assign(new Error('shopify graphql response missing data'), { status: 502 });
    }
    return body.data;
  }
}
