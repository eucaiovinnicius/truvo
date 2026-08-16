import { sha256 } from '../../../events/crypto.util';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import { FINANCIAL_STATUS_UNCHANGED } from '../../commerce/commerce-write.service';
import { SHOPIFY_PROVIDER } from './shopify.constants';
import type { NormalizedCommerceLineItem, NormalizedCommerceOrder, NormalizedCommerceRefund, NormalizedIdentifier, NormalizedRecord } from '../../contracts';

/**
 * Order 060 §4 — pure translation from Shopify's shapes into provider-neutral
 * canonical records. NO identity matching happens here (no lookups, no DB, no
 * decisions about who a customer "really" is) — that is
 * `IdentityGraphService`'s job, via `CanonicalMappingService`. This file only
 * EMITS namespaced identifiers/commerce data; it never resolves them.
 *
 * Email/phone hashes use `LEGACY_IDENTITY_NAMESPACE` ('truvo.identity') —
 * deliberately the SAME shared namespace the v1 bridge and every other provider
 * use for approved hashed contact identifiers, not a Shopify-specific one. This is
 * what makes "Shopify + Klaviyo same approved hashed identity resolves
 * consistently" (Order 045's own proven behavior) work for a REAL provider: two
 * providers hashing the SAME email the SAME way land on the SAME
 * `customer_identifiers` row. The Shopify customer GID itself stays
 * provider-namespaced (`SHOPIFY_PROVIDER`) — provider-scoped opaque IDs must never
 * collide with another provider's IDs of the same raw string (Order 045's
 * collision-safety guarantee).
 */

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyCustomerRef {
  id: string;
  email?: string | null;
  phone?: string | null;
}

export interface ShopifyLineItemNode {
  id: string;
  name: string;
  quantity: number;
  discountedUnitPriceSet: { shopMoney: ShopifyMoney };
  product: { id: string } | null;
  variant: { id: string } | null;
}

export interface ShopifyRefundNode {
  id: string;
  createdAt: string;
  totalRefundedSet: { shopMoney: ShopifyMoney };
  note?: string | null;
}

export interface ShopifyOrderNode {
  id: string;
  displayFinancialStatus: string;
  currentTotalPriceSet: { shopMoney: ShopifyMoney };
  processedAt: string;
  customer: ShopifyCustomerRef | null;
  lineItems: { nodes: ShopifyLineItemNode[] };
  refunds: ShopifyRefundNode[];
}

/** Shopify's GraphQL enum values (`PAID`, `PARTIALLY_REFUNDED`, ...) lowercased to
 * match the provider-neutral vocabulary `CommerceWriteService.isRevenueRecognized`
 * already uses — one lowercase vocabulary across every future order source, not a
 * Shopify-cased one. */
function normalizeFinancialStatus(status: string): string {
  return status.toLowerCase();
}

function normalizeEmailHash(email: string | null | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? sha256(trimmed) : undefined;
}

function normalizePhoneHash(phone: string | null | undefined): string | undefined {
  const digits = phone?.replace(/[^\d]/g, '');
  return digits ? sha256(digits) : undefined;
}

function customerIdentifiers(customer: ShopifyCustomerRef | null): NormalizedIdentifier[] {
  if (!customer) return [];
  const identifiers: NormalizedIdentifier[] = [
    { providerNamespace: SHOPIFY_PROVIDER, identifierType: 'external_id', identifierValue: customer.id },
  ];
  const emailHash = normalizeEmailHash(customer.email);
  if (emailHash) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: emailHash });
  const phoneHash = normalizePhoneHash(customer.phone);
  if (phoneHash) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'phone_hash', identifierValue: phoneHash });
  return identifiers;
}

function mapLineItem(node: ShopifyLineItemNode): NormalizedCommerceLineItem {
  return {
    providerLineItemId: node.id,
    providerProductId: node.product?.id,
    providerVariantId: node.variant?.id,
    name: node.name,
    quantity: node.quantity,
    price: Number(node.discountedUnitPriceSet.shopMoney.amount),
    currency: node.discountedUnitPriceSet.shopMoney.currencyCode,
  };
}

function mapRefund(node: ShopifyRefundNode): NormalizedCommerceRefund {
  return {
    providerRefundId: node.id,
    amount: Number(node.totalRefundedSet.shopMoney.amount),
    currency: node.totalRefundedSet.shopMoney.currencyCode,
    refundedAt: node.createdAt,
    reason: node.note ?? undefined,
  };
}

/** Full order → canonical record. Used by backfill/incremental pull and by the
 * `orders/*` webhook topics (which carry the complete current order state). */
export function mapShopifyOrder(node: ShopifyOrderNode): NormalizedRecord {
  const commerceOrder: NormalizedCommerceOrder = {
    providerNamespace: SHOPIFY_PROVIDER,
    providerOrderId: node.id,
    financialStatus: normalizeFinancialStatus(node.displayFinancialStatus),
    currency: node.currentTotalPriceSet.shopMoney.currencyCode,
    totalAmount: Number(node.currentTotalPriceSet.shopMoney.amount),
    orderTimestamp: node.processedAt,
    lineItems: node.lineItems.nodes.map(mapLineItem),
    refunds: node.refunds.length > 0 ? node.refunds.map(mapRefund) : undefined,
  };

  return {
    identifiers: customerIdentifiers(node.customer),
    commerceOrder,
    observedAt: node.processedAt,
  };
}

/** Refund-only webhook payload (Shopify's `refunds/create` topic does NOT include
 * the parent order's customer/status/line items — only the refund + order gid). */
export interface ShopifyRefundWebhookPayload {
  id: string;
  order_id: string;
  created_at: string;
  note?: string | null;
  transactions?: Array<{ amount?: string; currency?: string }>;
}

export function mapShopifyRefundWebhook(payload: ShopifyRefundWebhookPayload): NormalizedRecord | null {
  const amount = payload.transactions?.reduce((sum, t) => sum + Number(t.amount ?? 0), 0) ?? 0;
  const currency = payload.transactions?.[0]?.currency;
  if (!currency) return null; // nothing usable — REST webhook shape without a currency is unparseable, safely skip.

  const commerceOrder: NormalizedCommerceOrder = {
    providerNamespace: SHOPIFY_PROVIDER,
    providerOrderId: `gid://shopify/Order/${payload.order_id}`,
    financialStatus: FINANCIAL_STATUS_UNCHANGED,
    currency,
    totalAmount: 0,
    orderTimestamp: payload.created_at,
    lineItems: [],
    refunds: [{ providerRefundId: `gid://shopify/Refund/${payload.id}`, amount, currency, refundedAt: payload.created_at, reason: payload.note ?? undefined }],
  };

  return { identifiers: [], commerceOrder, observedAt: payload.created_at };
}
