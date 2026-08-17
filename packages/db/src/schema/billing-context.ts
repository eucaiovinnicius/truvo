import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { connectorConnections } from './connectors';
import { customers } from './customer-context';

/**
 * Order 062 — durable, provider-neutral billing context. This deliberately does
 * not reuse M11's `subscriptions`: that table is Truvo's own feature-gating
 * subscription (one per workspace), while these tables model a connected
 * customer's provider billing history (many per customer/workspace).
 */
const common = {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  connectionId: text('connection_id').notNull(),
  customerId: text('customer_id'),
  providerNamespace: text('provider_namespace').notNull(),
  sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const commonRelations = (t: { workspaceId: any; connectionId: any; customerId: any; providerNamespace: any }) => ({
  connectionFk: foreignKey({ columns: [t.workspaceId, t.connectionId], foreignColumns: [connectorConnections.workspaceId, connectorConnections.id] }).onDelete('cascade'),
  customerFk: foreignKey({ columns: [t.workspaceId, t.customerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('set null'),
});

export const billingContextSubscriptions = pgTable('billing_context_subscriptions', {
  ...common,
  providerSubscriptionId: text('provider_subscription_id').notNull(),
  providerCustomerId: text('provider_customer_id'), status: text('status').notNull(),
  productReference: text('product_reference'), priceReference: text('price_reference'), quantity: integer('quantity'),
  startedAt: timestamp('started_at', { withTimezone: true }), trialStartAt: timestamp('trial_start_at', { withTimezone: true }), trialEndAt: timestamp('trial_end_at', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }), currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAt: timestamp('cancel_at', { withTimezone: true }), cancelledAt: timestamp('cancelled_at', { withTimezone: true }), endedAt: timestamp('ended_at', { withTimezone: true }),
  collectionMethod: text('collection_method'), paymentBehavior: text('payment_behavior'),
}, (t) => ({
  ...commonRelations(t), pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  naturalUq: uniqueIndex('billing_context_subscriptions_ws_provider_uq').on(t.workspaceId, t.providerNamespace, t.providerSubscriptionId),
  customerIdx: index('billing_context_subscriptions_ws_customer_idx').on(t.workspaceId, t.customerId),
  namespaceCheck: check('billing_context_subscriptions_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerSubscriptionId})) > 0`),
}));

export const billingContextInvoices = pgTable('billing_context_invoices', {
  ...common,
  providerInvoiceId: text('provider_invoice_id').notNull(), providerCustomerId: text('provider_customer_id'), providerSubscriptionId: text('provider_subscription_id'),
  status: text('status').notNull(), currency: text('currency').notNull(), amountDue: numeric('amount_due'), amountPaid: numeric('amount_paid'), amountRemaining: numeric('amount_remaining'),
  invoiceCreatedAt: timestamp('invoice_created_at', { withTimezone: true }), finalizedAt: timestamp('finalized_at', { withTimezone: true }), paidAt: timestamp('paid_at', { withTimezone: true }), voidedAt: timestamp('voided_at', { withTimezone: true }), uncollectibleAt: timestamp('uncollectible_at', { withTimezone: true }),
}, (t) => ({ ...commonRelations(t), pk: primaryKey({ columns: [t.workspaceId, t.id] }), naturalUq: uniqueIndex('billing_context_invoices_ws_provider_uq').on(t.workspaceId, t.providerNamespace, t.providerInvoiceId), customerIdx: index('billing_context_invoices_ws_customer_idx').on(t.workspaceId, t.customerId), namespaceCheck: check('billing_context_invoices_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerInvoiceId})) > 0 AND length(trim(${t.currency})) > 0`) }));

export const billingContextPayments = pgTable('billing_context_payments', {
  ...common,
  providerPaymentId: text('provider_payment_id').notNull(), providerCustomerId: text('provider_customer_id'), providerSubscriptionId: text('provider_subscription_id'), providerInvoiceId: text('provider_invoice_id'),
  status: text('status').notNull(), amount: numeric('amount').notNull(), currency: text('currency').notNull(), failureCode: text('failure_code'), failureMessage: text('failure_message'), succeededAt: timestamp('succeeded_at', { withTimezone: true }), failedAt: timestamp('failed_at', { withTimezone: true }),
}, (t) => ({ ...commonRelations(t), pk: primaryKey({ columns: [t.workspaceId, t.id] }), naturalUq: uniqueIndex('billing_context_payments_ws_provider_uq').on(t.workspaceId, t.providerNamespace, t.providerPaymentId), customerIdx: index('billing_context_payments_ws_customer_idx').on(t.workspaceId, t.customerId), namespaceCheck: check('billing_context_payments_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerPaymentId})) > 0 AND length(trim(${t.currency})) > 0`) }));

export const billingContextAdjustments = pgTable('billing_context_adjustments', {
  ...common,
  providerAdjustmentId: text('provider_adjustment_id').notNull(), providerCustomerId: text('provider_customer_id'), providerPaymentId: text('provider_payment_id'), providerInvoiceId: text('provider_invoice_id'),
  status: text('status').notNull(), amount: numeric('amount').notNull(), currency: text('currency').notNull(), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
}, (t) => ({ ...commonRelations(t), pk: primaryKey({ columns: [t.workspaceId, t.id] }), naturalUq: uniqueIndex('billing_context_adjustments_ws_provider_uq').on(t.workspaceId, t.providerNamespace, t.providerAdjustmentId), customerIdx: index('billing_context_adjustments_ws_customer_idx').on(t.workspaceId, t.customerId), namespaceCheck: check('billing_context_adjustments_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerAdjustmentId})) > 0 AND length(trim(${t.currency})) > 0`) }));

export type BillingContextSubscription = typeof billingContextSubscriptions.$inferSelect;
export type BillingContextInvoice = typeof billingContextInvoices.$inferSelect;
export type BillingContextPayment = typeof billingContextPayments.$inferSelect;
export type BillingContextAdjustment = typeof billingContextAdjustments.$inferSelect;
