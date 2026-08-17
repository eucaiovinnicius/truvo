/**
 * Order 062 provider contract, verified 2026-08-16 against Stripe's official
 * Connect OAuth and webhook documentation. OAuth connects a Standard account;
 * API calls use the platform key plus the immutable `Stripe-Account` header.
 * API version is intentionally pinned, never inferred from the account default.
 */
export const STRIPE_PROVIDER = 'stripe';
export const STRIPE_API_VERSION = '2025-06-30.basil';
export const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
export const STRIPE_OAUTH_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';
export const STRIPE_OAUTH_TOKEN_URL = 'https://connect.stripe.com/oauth/token';
export const STRIPE_OAUTH_DEAUTHORIZE_URL = 'https://connect.stripe.com/oauth/deauthorize';
export const STRIPE_INCREMENTAL_STREAMS = ['customers', 'subscriptions', 'invoices', 'payments', 'refunds'] as const;
export const STRIPE_WEBHOOK_EVENTS = ['customer.created', 'customer.updated', 'customer.deleted', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded', 'refund.created', 'account.application.deauthorized'] as const;
export const STRIPE_PAGE_SIZE = 100;
