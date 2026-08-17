import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  billingContextAdjustments,
  billingContextInvoices,
  billingContextPayments,
  billingContextSubscriptions,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { CustomerContextService } from '../../customer-context/customer-context.service';
import type {
  NormalizedBillingAdjustment,
  NormalizedBillingInvoice,
  NormalizedBillingPayment,
  NormalizedBillingSubscription,
} from '../contracts';

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

function asDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Order 062 — one canonical writer for provider-neutral billing state. Every
 * update is guarded by `source_updated_at`: a delayed webhook can be stored in
 * the durable delivery ledger but never regress a newer provider projection. */
@Injectable()
export class BillingContextWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customerContext: CustomerContextService,
  ) {}

  async upsertSubscription(workspaceId: string, connectionId: string, customerId: string | null, input: NormalizedBillingSubscription): Promise<string | null> {
    const sourceUpdatedAt = new Date(input.sourceUpdatedAt);
    const id = deterministicId('bcs', workspaceId, input.providerNamespace, input.providerSubscriptionId);
    await this.db.insert(billingContextSubscriptions).values({
      workspaceId, id, connectionId, customerId, providerNamespace: input.providerNamespace, providerSubscriptionId: input.providerSubscriptionId,
      providerCustomerId: input.providerCustomerId ?? null, status: input.status, productReference: input.productReference ?? null, priceReference: input.priceReference ?? null,
      quantity: input.quantity ?? null, startedAt: asDate(input.startedAt), trialStartAt: asDate(input.trialStartAt), trialEndAt: asDate(input.trialEndAt),
      currentPeriodStart: asDate(input.currentPeriodStart), currentPeriodEnd: asDate(input.currentPeriodEnd), cancelAt: asDate(input.cancelAt), cancelledAt: asDate(input.cancelledAt), endedAt: asDate(input.endedAt),
      collectionMethod: input.collectionMethod ?? null, paymentBehavior: input.paymentBehavior ?? null, sourceUpdatedAt,
    }).onConflictDoUpdate({
      target: [billingContextSubscriptions.workspaceId, billingContextSubscriptions.providerNamespace, billingContextSubscriptions.providerSubscriptionId],
      set: { customerId: sql`coalesce(${customerId}, ${billingContextSubscriptions.customerId})`, providerCustomerId: input.providerCustomerId ?? null, status: input.status, productReference: input.productReference ?? null, priceReference: input.priceReference ?? null, quantity: input.quantity ?? null, startedAt: asDate(input.startedAt), trialStartAt: asDate(input.trialStartAt), trialEndAt: asDate(input.trialEndAt), currentPeriodStart: asDate(input.currentPeriodStart), currentPeriodEnd: asDate(input.currentPeriodEnd), cancelAt: asDate(input.cancelAt), cancelledAt: asDate(input.cancelledAt), endedAt: asDate(input.endedAt), collectionMethod: input.collectionMethod ?? null, paymentBehavior: input.paymentBehavior ?? null, sourceUpdatedAt, updatedAt: new Date() },
      where: sql`${billingContextSubscriptions.sourceUpdatedAt} <= ${sourceUpdatedAt.toISOString()}::timestamptz`,
    });
    const [row] = await this.db.select({ customerId: billingContextSubscriptions.customerId }).from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, workspaceId), eq(billingContextSubscriptions.providerNamespace, input.providerNamespace), eq(billingContextSubscriptions.providerSubscriptionId, input.providerSubscriptionId))).limit(1);
    return row?.customerId ?? null;
  }

  async upsertInvoice(workspaceId: string, connectionId: string, customerId: string | null, input: NormalizedBillingInvoice): Promise<string | null> {
    const sourceUpdatedAt = new Date(input.sourceUpdatedAt); const id = deterministicId('bci', workspaceId, input.providerNamespace, input.providerInvoiceId);
    await this.db.insert(billingContextInvoices).values({ workspaceId, id, connectionId, customerId, providerNamespace: input.providerNamespace, providerInvoiceId: input.providerInvoiceId, providerCustomerId: input.providerCustomerId ?? null, providerSubscriptionId: input.providerSubscriptionId ?? null, status: input.status, currency: input.currency, amountDue: input.amountDue?.toString() ?? null, amountPaid: input.amountPaid?.toString() ?? null, amountRemaining: input.amountRemaining?.toString() ?? null, invoiceCreatedAt: asDate(input.createdAt), finalizedAt: asDate(input.finalizedAt), paidAt: asDate(input.paidAt), voidedAt: asDate(input.voidedAt), uncollectibleAt: asDate(input.uncollectibleAt), sourceUpdatedAt }).onConflictDoUpdate({ target: [billingContextInvoices.workspaceId, billingContextInvoices.providerNamespace, billingContextInvoices.providerInvoiceId], set: { customerId: sql`coalesce(${customerId}, ${billingContextInvoices.customerId})`, providerCustomerId: input.providerCustomerId ?? null, providerSubscriptionId: input.providerSubscriptionId ?? null, status: input.status, currency: input.currency, amountDue: input.amountDue?.toString() ?? null, amountPaid: input.amountPaid?.toString() ?? null, amountRemaining: input.amountRemaining?.toString() ?? null, invoiceCreatedAt: asDate(input.createdAt), finalizedAt: asDate(input.finalizedAt), paidAt: asDate(input.paidAt), voidedAt: asDate(input.voidedAt), uncollectibleAt: asDate(input.uncollectibleAt), sourceUpdatedAt, updatedAt: new Date() }, where: sql`${billingContextInvoices.sourceUpdatedAt} <= ${sourceUpdatedAt.toISOString()}::timestamptz` });
    const [row] = await this.db.select({ customerId: billingContextInvoices.customerId }).from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, workspaceId), eq(billingContextInvoices.providerNamespace, input.providerNamespace), eq(billingContextInvoices.providerInvoiceId, input.providerInvoiceId))).limit(1); return row?.customerId ?? null;
  }

  async upsertPayment(workspaceId: string, connectionId: string, customerId: string | null, input: NormalizedBillingPayment): Promise<string | null> {
    const sourceUpdatedAt = new Date(input.sourceUpdatedAt); const id = deterministicId('bcp', workspaceId, input.providerNamespace, input.providerPaymentId);
    await this.db.insert(billingContextPayments).values({ workspaceId, id, connectionId, customerId, providerNamespace: input.providerNamespace, providerPaymentId: input.providerPaymentId, providerCustomerId: input.providerCustomerId ?? null, providerSubscriptionId: input.providerSubscriptionId ?? null, providerInvoiceId: input.providerInvoiceId ?? null, status: input.status, amount: input.amount.toString(), currency: input.currency, failureCode: input.failureCode ?? null, failureMessage: input.failureMessage ?? null, succeededAt: asDate(input.succeededAt), failedAt: asDate(input.failedAt), sourceUpdatedAt }).onConflictDoUpdate({ target: [billingContextPayments.workspaceId, billingContextPayments.providerNamespace, billingContextPayments.providerPaymentId], set: { customerId: sql`coalesce(${customerId}, ${billingContextPayments.customerId})`, providerCustomerId: input.providerCustomerId ?? null, providerSubscriptionId: input.providerSubscriptionId ?? null, providerInvoiceId: input.providerInvoiceId ?? null, status: input.status, amount: input.amount.toString(), currency: input.currency, failureCode: input.failureCode ?? null, failureMessage: input.failureMessage ?? null, succeededAt: asDate(input.succeededAt), failedAt: asDate(input.failedAt), sourceUpdatedAt, updatedAt: new Date() }, where: sql`${billingContextPayments.sourceUpdatedAt} <= ${sourceUpdatedAt.toISOString()}::timestamptz` });
    const [row] = await this.db.select({ customerId: billingContextPayments.customerId }).from(billingContextPayments).where(and(eq(billingContextPayments.workspaceId, workspaceId), eq(billingContextPayments.providerNamespace, input.providerNamespace), eq(billingContextPayments.providerPaymentId, input.providerPaymentId))).limit(1); return row?.customerId ?? null;
  }

  async upsertAdjustment(workspaceId: string, connectionId: string, customerId: string | null, input: NormalizedBillingAdjustment): Promise<string | null> {
    const sourceUpdatedAt = new Date(input.sourceUpdatedAt); const id = deterministicId('bca', workspaceId, input.providerNamespace, input.providerAdjustmentId);
    await this.db.insert(billingContextAdjustments).values({ workspaceId, id, connectionId, customerId, providerNamespace: input.providerNamespace, providerAdjustmentId: input.providerAdjustmentId, providerCustomerId: input.providerCustomerId ?? null, providerPaymentId: input.providerPaymentId ?? null, providerInvoiceId: input.providerInvoiceId ?? null, status: input.status, amount: input.amount.toString(), currency: input.currency, occurredAt: new Date(input.occurredAt), sourceUpdatedAt }).onConflictDoUpdate({ target: [billingContextAdjustments.workspaceId, billingContextAdjustments.providerNamespace, billingContextAdjustments.providerAdjustmentId], set: { customerId: sql`coalesce(${customerId}, ${billingContextAdjustments.customerId})`, providerCustomerId: input.providerCustomerId ?? null, providerPaymentId: input.providerPaymentId ?? null, providerInvoiceId: input.providerInvoiceId ?? null, status: input.status, amount: input.amount.toString(), currency: input.currency, occurredAt: new Date(input.occurredAt), sourceUpdatedAt, updatedAt: new Date() }, where: sql`${billingContextAdjustments.sourceUpdatedAt} <= ${sourceUpdatedAt.toISOString()}::timestamptz` });
    const [row] = await this.db.select({ customerId: billingContextAdjustments.customerId }).from(billingContextAdjustments).where(and(eq(billingContextAdjustments.workspaceId, workspaceId), eq(billingContextAdjustments.providerNamespace, input.providerNamespace), eq(billingContextAdjustments.providerAdjustmentId, input.providerAdjustmentId))).limit(1); return row?.customerId ?? null;
  }

  async recomputeDerivedTraits(workspaceId: string, customerId: string): Promise<void> {
    const [subscriptions, invoices, payments] = await Promise.all([
      this.db.select().from(billingContextSubscriptions).where(and(eq(billingContextSubscriptions.workspaceId, workspaceId), eq(billingContextSubscriptions.customerId, customerId))),
      this.db.select().from(billingContextInvoices).where(and(eq(billingContextInvoices.workspaceId, workspaceId), eq(billingContextInvoices.customerId, customerId))),
      this.db.select().from(billingContextPayments).where(and(eq(billingContextPayments.workspaceId, workspaceId), eq(billingContextPayments.customerId, customerId))),
    ]);
    const active = subscriptions.filter((s) => ['active', 'trialing', 'past_due'].includes(s.status));
    const paidByCurrency: Record<string, number> = {}; const remainingByCurrency: Record<string, number> = {};
    for (const invoice of invoices) { paidByCurrency[invoice.currency] = (paidByCurrency[invoice.currency] ?? 0) + Number(invoice.amountPaid ?? 0); remainingByCurrency[invoice.currency] = (remainingByCurrency[invoice.currency] ?? 0) + Number(invoice.amountRemaining ?? 0); }
    const successful = payments.filter((p) => p.status === 'succeeded' && p.succeededAt).sort((a, b) => (b.succeededAt?.getTime() ?? 0) - (a.succeededAt?.getTime() ?? 0));
    const failed = payments.filter((p) => ['failed', 'requires_payment_method'].includes(p.status)).length;
    const now = new Date();
    await Promise.all([
      this.customerContext.upsertTrait({ type: 'number', value: active.length, workspaceId, customerId, traitNamespace: 'billing', traitKey: 'active_subscription_count', sourceNamespace: 'connector.billing', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: active.map((s) => ({ subscription_id: s.providerSubscriptionId, status: s.status, product_reference: s.productReference, price_reference: s.priceReference, quantity: s.quantity, trial_end: s.trialEndAt?.toISOString(), current_period_end: s.currentPeriodEnd?.toISOString(), cancel_at: s.cancelAt?.toISOString(), cancelled_at: s.cancelledAt?.toISOString() })), workspaceId, customerId, traitNamespace: 'billing', traitKey: 'current_subscriptions', sourceNamespace: 'connector.billing', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'number', value: failed, workspaceId, customerId, traitNamespace: 'billing', traitKey: 'payment_failure_count', sourceNamespace: 'connector.billing', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: paidByCurrency, workspaceId, customerId, traitNamespace: 'billing', traitKey: 'amount_paid_by_currency', sourceNamespace: 'connector.billing', observedAt: now }),
      this.customerContext.upsertTrait({ type: 'json', value: remainingByCurrency, workspaceId, customerId, traitNamespace: 'billing', traitKey: 'amount_remaining_by_currency', sourceNamespace: 'connector.billing', observedAt: now }),
      ...(successful[0]?.succeededAt ? [this.customerContext.upsertTrait({ type: 'datetime' as const, value: successful[0].succeededAt.toISOString(), workspaceId, customerId, traitNamespace: 'billing', traitKey: 'last_successful_billing_at', sourceNamespace: 'connector.billing', observedAt: now })] : []),
    ]);
  }
}
