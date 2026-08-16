/**
 * Order 060 §1 — Shopify Admin API version, PINNED explicitly. Never resolved at
 * runtime, never auto-upgraded.
 *
 * Verified 2026-08-16 against Shopify's official versioning docs
 * (shopify.dev/docs/api/usage/versioning): Shopify releases a new stable version
 * every 3 months (Jan/Apr/Jul/Oct at 5pm UTC), each supported for a minimum of 12
 * months. As of this date the current stable release is 2026-07 (released
 * 2026-07-01; 2026-10 had not yet released). Bumping this constant is a deliberate,
 * reviewed change — not something this adapter does on its own.
 */
export const SHOPIFY_API_VERSION = '2026-07';

export const SHOPIFY_PROVIDER = 'shopify';

/**
 * Least-privilege scopes for the reads/webhooks this adapter actually uses —
 * customers (identity + guest/identified customer records), orders (backfill +
 * purchase/refund semantics), products (line item product/variant cross-sell
 * context). No write scopes, no scopes for capabilities not implemented.
 */
export const SHOPIFY_REQUIRED_SCOPES = ['read_customers', 'read_orders', 'read_products'] as const;

/** Webhook topics this adapter's `normalizeWebhook` understands. */
export const SHOPIFY_WEBHOOK_TOPICS = ['orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled', 'refunds/create', 'customers/create', 'customers/update'] as const;
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

export const DEFAULT_PAGE_SIZE = 50;
