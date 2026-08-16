import { verifyShopify } from '../../../webhooks/crypto/signature';
import type {
  ConnectionTestResult,
  ConnectorConnection,
  ConnectorDefinition,
  NormalizedRecord,
  RawWebhookRequest,
  SourceAdapter,
  SourcePullResult,
  SyncCheckpoint,
} from '../../contracts';
import { DEFAULT_PAGE_SIZE, SHOPIFY_PROVIDER, SHOPIFY_REQUIRED_SCOPES, SHOPIFY_WEBHOOK_TOPICS } from './shopify.constants';
import { ShopifyGraphQLClient, type ShopifyCredentials, type ShopifyFetch } from './shopify.graphql-client';
import { mapShopifyOrder, mapShopifyRefundWebhook, type ShopifyOrderNode, type ShopifyRefundWebhookPayload } from './shopify.mapper';

/**
 * Order 060 §1/§2/§3/§6 — the real Shopify `SourceAdapter`. Radar/ML logic is
 * intentionally absent — this file only reads Shopify and emits `NormalizedRecord`s
 * through the SAME `SourceAdapter` contract the fake provider (Order 050) proves.
 *
 * Pagination uses Shopify's standard GraphQL cursor connection (`orders(first,
 * after)`), not the async Bulk Operations API — sufficient for incremental/webhook
 * volumes and a bounded initial backfill; a future large-catalog optimization can
 * add Bulk Operations as an additive capability without changing this contract.
 */

const DEFINITION: ConnectorDefinition = {
  provider: SHOPIFY_PROVIDER,
  displayName: 'Shopify',
  role: 'source',
  capabilities: ['webhook_ingest', 'initial_backfill', 'incremental_pull'],
  credentialKind: 'api_key',
};

const SCOPES_QUERY = `
  query CheckScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

interface ScopesResponse {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
}

const ORDERS_QUERY = `
  query Orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        displayFinancialStatus
        processedAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id email phone }
        lineItems(first: 50) {
          nodes {
            id
            name
            quantity
            discountedUnitPriceSet { shopMoney { amount currencyCode } }
            product { id }
            variant { id }
          }
        }
        refunds {
          id
          createdAt
          note
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

interface OrdersResponse {
  orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrderNode[] };
}

function credentialsOf(connection: ConnectorConnection, credentials: Record<string, unknown>): ShopifyCredentials {
  const shopDomain = (connection.config.shop_domain as string | undefined) ?? '';
  const accessToken = (credentials.access_token as string | undefined) ?? '';
  return { shop_domain: shopDomain, access_token: accessToken };
}

async function testConnection(
  connection: ConnectorConnection,
  credentials: Record<string, unknown>,
  fetchImpl: ShopifyFetch,
): Promise<ConnectionTestResult> {
  const creds = credentialsOf(connection, credentials);
  if (!creds.shop_domain || !creds.access_token) {
    return { ok: false, credentialStatus: 'invalid', checks: { shop_domain: !!creds.shop_domain, access_token: !!creds.access_token }, message: 'missing shop_domain or access_token' };
  }

  const client = new ShopifyGraphQLClient(creds, fetchImpl);
  try {
    const data = await client.request<ScopesResponse>(SCOPES_QUERY);
    const granted = new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
    const checks = Object.fromEntries(SHOPIFY_REQUIRED_SCOPES.map((scope) => [scope, granted.has(scope)]));
    const missing = SHOPIFY_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return { ok: false, credentialStatus: 'invalid', checks, message: `missing scopes: ${missing.join(', ')}` };
    }
    return { ok: true, credentialStatus: 'valid', checks, message: 'ok' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { ok: false, credentialStatus: 'invalid', checks: {}, message: (err as Error).message, authFailure: true };
    }
    throw err;
  }
}

async function pull(
  connection: ConnectorConnection,
  credentials: Record<string, unknown>,
  checkpoint: SyncCheckpoint,
  fetchImpl: ShopifyFetch,
  sinceQuery?: (cursorTimestamp: string) => string,
): Promise<SourcePullResult> {
  const client = new ShopifyGraphQLClient(credentialsOf(connection, credentials), fetchImpl);
  // `checkpoint.cursor` stores the Shopify pagination cursor while a page is being
  // walked; once a stream is caught up (`hasNextPage: false`), the NEXT call starts
  // a fresh page walk with no `after`, filtered by `sinceQuery` if the caller wants
  // incremental (updated_at-scoped) semantics rather than a full re-walk.
  const after = checkpoint.cursor && checkpoint.status === 'running' ? checkpoint.cursor : null;
  const query = !after && sinceQuery ? sinceQuery(checkpoint.cursor ?? new Date(0).toISOString()) : undefined;

  const data = await client.request<OrdersResponse>(ORDERS_QUERY, { first: DEFAULT_PAGE_SIZE, after, query });
  const records: NormalizedRecord[] = data.orders.nodes.map(mapShopifyOrder);
  const lastNode = data.orders.nodes.at(-1);
  const nextCursor = data.orders.pageInfo.hasNextPage
    ? data.orders.pageInfo.endCursor
    : (lastNode?.processedAt ?? checkpoint.cursor);

  return { records, nextCursor, hasMore: data.orders.pageInfo.hasNextPage };
}

export function createShopifyAdapter(fetchImpl: ShopifyFetch = fetch): SourceAdapter {
  return {
    definition: DEFINITION,
    testConnection: (connection, credentials) => testConnection(connection, credentials, fetchImpl),
    initialBackfill: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, fetchImpl),
    incrementalPull: (connection, credentials, checkpoint) =>
      pull(connection, credentials, checkpoint, fetchImpl, (since) => `updated_at:>='${since}'`),
    verifyWebhook: (connection, credentials, request: RawWebhookRequest) => {
      const secret = (credentials.webhook_secret as string | undefined) ?? '';
      const raw = request.rawBody ?? Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}));
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ) as Record<string, string | undefined>;
      return verifyShopify({ raw, headers, query: {}, secret });
    },
    normalizeWebhook: (_connection, request: RawWebhookRequest): NormalizedRecord[] | null => {
      const topicHeader = request.headers['x-shopify-topic'];
      const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader;
      if (!topic || !(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic)) return null;

      const body = request.body as Record<string, unknown> | undefined;
      if (!body) return null;

      if (topic === 'refunds/create') {
        const record = mapShopifyRefundWebhook(body as unknown as ShopifyRefundWebhookPayload);
        return record ? [record] : null;
      }

      if (topic.startsWith('orders/')) {
        // REST webhook payload — same essential shape as the GraphQL order node for
        // the fields this adapter needs, adapted to `ShopifyOrderNode`'s field names.
        const node: ShopifyOrderNode = {
          id: `gid://shopify/Order/${body.id}`,
          displayFinancialStatus: String(body.financial_status ?? 'pending').toUpperCase(),
          processedAt: String(body.processed_at ?? body.created_at ?? new Date().toISOString()),
          currentTotalPriceSet: {
            shopMoney: { amount: String(body.total_price ?? '0'), currencyCode: String(body.currency ?? 'USD') },
          },
          customer: body.customer
            ? {
                id: `gid://shopify/Customer/${(body.customer as Record<string, unknown>).id}`,
                email: (body.customer as Record<string, unknown>).email as string | undefined,
                phone: (body.customer as Record<string, unknown>).phone as string | undefined,
              }
            : null,
          lineItems: {
            nodes: ((body.line_items as Array<Record<string, unknown>>) ?? []).map((li) => ({
              id: `gid://shopify/LineItem/${li.id}`,
              name: String(li.name ?? li.title ?? ''),
              quantity: Number(li.quantity ?? 0),
              discountedUnitPriceSet: { shopMoney: { amount: String(li.price ?? '0'), currencyCode: String(body.currency ?? 'USD') } },
              product: li.product_id ? { id: `gid://shopify/Product/${li.product_id}` } : null,
              variant: li.variant_id ? { id: `gid://shopify/ProductVariant/${li.variant_id}` } : null,
            })),
          },
          refunds: [],
        };
        return [mapShopifyOrder(node)];
      }

      return null;
    },
  };
}
