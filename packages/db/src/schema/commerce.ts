import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { customers } from './customer-context';
import { connectorConnections } from './connectors';

/**
 * Order 060 — provider-neutral commerce representation. No existing table could
 * hold order/line-item/refund state (confirmed by inspection — Order 30's
 * `customers`/`customer_identifiers`/`customer_traits`/`customer_relationships`
 * model identity/traits/person-to-person relationships, none of them an order),
 * so this is the minimum additive schema the order allows. Nothing here is
 * Shopify-specific: `provider_namespace` + `provider_order_id` namespace the
 * source exactly like `customer_identifiers` already does, so a future
 * Stripe/Hotmart/Kiwify order source can write into the SAME tables.
 *
 * `customer_id` is NULLABLE — a guest checkout has no resolved identity yet
 * (Order 060 §8 edge case: "guest checkout without Shopify customer"). A later
 * "guest -> identified" signal re-resolves the SAME order row (matched by the
 * unique provider_order_id key) to a real customer without duplicating it.
 *
 * Economic outcome semantics: a PAID order additionally gets mirrored into
 * `customer_outcomes` (Order 40) as a `commerce.purchase` observation — same
 * dedupe-key mechanism, so `customer_outcomes` stays the SINGLE purchase truth.
 * Refunds are their OWN adjustment record here, linked to the original order —
 * per the order's explicit instruction, they do NOT reverse/mutate the purchase
 * outcome (that reversal policy is still an open Order 40 decision).
 */
export const commerceOrders = pgTable(
  'commerce_orders',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    /** Nullable: guest checkout, no resolved identity yet. */
    customerId: text('customer_id'),
    providerNamespace: text('provider_namespace').notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    financialStatus: text('financial_status').notNull(),
    currency: text('currency').notNull(),
    totalAmount: numeric('total_amount').notNull(),
    orderTimestamp: timestamp('order_timestamp', { withTimezone: true }).notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    provenance: text('provenance'), // free-form JSON string (raw provider order id/edit history pointer) — kept minimal, not a full raw-payload mirror
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'commerce_orders_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    customerFk: foreignKey({
      name: 'commerce_orders_customer_fk',
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('set null'),
    naturalUq: uniqueIndex('commerce_orders_ws_provider_order_uq').on(t.workspaceId, t.providerNamespace, t.providerOrderId),
    customerIdx: index('commerce_orders_ws_customer_idx').on(t.workspaceId, t.customerId),
    namespaceCheck: check('commerce_orders_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerOrderId})) > 0 AND length(trim(${t.currency})) > 0`),
  }),
);

export const commerceOrderLineItems = pgTable(
  'commerce_order_line_items',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    orderId: text('order_id').notNull(),
    providerLineItemId: text('provider_line_item_id').notNull(),
    providerProductId: text('provider_product_id'),
    providerVariantId: text('provider_variant_id'),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    price: numeric('price').notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    orderFk: foreignKey({
      name: 'commerce_order_line_items_order_fk',
      columns: [t.workspaceId, t.orderId],
      foreignColumns: [commerceOrders.workspaceId, commerceOrders.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('commerce_order_line_items_ws_order_item_uq').on(t.workspaceId, t.orderId, t.providerLineItemId),
    productIdx: index('commerce_order_line_items_ws_product_idx').on(t.workspaceId, t.providerProductId),
  }),
);

export const commerceRefunds = pgTable(
  'commerce_refunds',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    orderId: text('order_id').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    providerRefundId: text('provider_refund_id').notNull(),
    amount: numeric('amount').notNull(),
    currency: text('currency').notNull(),
    reason: text('reason'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    orderFk: foreignKey({
      name: 'commerce_refunds_order_fk',
      columns: [t.workspaceId, t.orderId],
      foreignColumns: [commerceOrders.workspaceId, commerceOrders.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('commerce_refunds_ws_provider_refund_uq').on(t.workspaceId, t.providerNamespace, t.providerRefundId),
    orderIdx: index('commerce_refunds_ws_order_idx').on(t.workspaceId, t.orderId),
  }),
);

export type CommerceOrder = typeof commerceOrders.$inferSelect;
export type CommerceOrderLineItem = typeof commerceOrderLineItems.$inferSelect;
export type CommerceRefund = typeof commerceRefunds.$inferSelect;
