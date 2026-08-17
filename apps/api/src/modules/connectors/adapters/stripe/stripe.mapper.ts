import { sha256 } from '../../../events/crypto.util';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import type { NormalizedIdentifier, NormalizedRecord } from '../../contracts';
import { STRIPE_PROVIDER } from './stripe.constants';

type StripeObject = Record<string, any>;
function idOf(value: unknown): string | undefined { return typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined; }
function iso(value: unknown): string | undefined { return typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined; }
function observed(object: StripeObject, fallback = new Date().toISOString()): string { return iso(object.updated ?? object.created) ?? fallback; }
function amount(value: unknown): number { return Number(value ?? 0) / 100; }
function identifiers(customer: StripeObject | undefined): NormalizedIdentifier[] {
  if (!customer?.id) return [];
  const result: NormalizedIdentifier[] = [{ providerNamespace: STRIPE_PROVIDER, identifierType: 'external_id', identifierValue: String(customer.id) }];
  const email = typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : '';
  const phone = typeof customer.phone === 'string' ? customer.phone.replace(/[^\d]/g, '') : '';
  if (email) result.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: sha256(email) });
  if (phone) result.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'phone_hash', identifierValue: sha256(phone) });
  return result;
}

export function mapStripeCustomer(customer: StripeObject): NormalizedRecord {
  return { identifiers: identifiers(customer), traits: [{ traitNamespace: 'stripe', traitKey: 'customer_created_at', valueType: 'datetime', value: iso(customer.created) ?? new Date().toISOString() }], observedAt: observed(customer) };
}

export function mapStripeSubscription(subscription: StripeObject): NormalizedRecord {
  const customerId = idOf(subscription.customer); const item = subscription.items?.data?.[0]; const price = item?.price;
  const customer = customerId ? { id: customerId } : undefined;
  return { identifiers: identifiers(customer), billingSubscription: { providerNamespace: STRIPE_PROVIDER, providerSubscriptionId: subscription.id, providerCustomerId: customerId, status: subscription.status ?? 'unknown', productReference: idOf(price?.product), priceReference: idOf(price), quantity: item?.quantity, startedAt: iso(subscription.start_date), trialStartAt: iso(subscription.trial_start), trialEndAt: iso(subscription.trial_end), currentPeriodStart: iso(subscription.current_period_start), currentPeriodEnd: iso(subscription.current_period_end), cancelAt: iso(subscription.cancel_at), cancelledAt: iso(subscription.canceled_at), endedAt: iso(subscription.ended_at), collectionMethod: subscription.collection_method, paymentBehavior: subscription.payment_behavior, sourceUpdatedAt: observed(subscription) }, observedAt: observed(subscription) };
}

export function mapStripeInvoice(invoice: StripeObject): NormalizedRecord {
  const customerId = idOf(invoice.customer); const subscriptionId = idOf(invoice.subscription);
  return { identifiers: identifiers(customerId ? { id: customerId } : undefined), billingInvoice: { providerNamespace: STRIPE_PROVIDER, providerInvoiceId: invoice.id, providerCustomerId: customerId, providerSubscriptionId: subscriptionId, status: invoice.status ?? 'unknown', currency: String(invoice.currency ?? 'usd').toUpperCase(), amountDue: amount(invoice.amount_due), amountPaid: amount(invoice.amount_paid), amountRemaining: amount(invoice.amount_remaining), createdAt: iso(invoice.created), finalizedAt: iso(invoice.status_transitions?.finalized_at), paidAt: iso(invoice.status_transitions?.paid_at), voidedAt: iso(invoice.status_transitions?.voided_at), uncollectibleAt: iso(invoice.status_transitions?.marked_uncollectible_at), sourceUpdatedAt: observed(invoice) }, observedAt: observed(invoice) };
}

export function mapStripePayment(payment: StripeObject): NormalizedRecord {
  const customerId = idOf(payment.customer); const invoiceId = idOf(payment.invoice); const subscriptionId = idOf(payment.metadata?.subscription_id) ?? idOf(payment.subscription);
  const succeeded = payment.status === 'succeeded'; const failed = ['requires_payment_method', 'canceled'].includes(payment.status);
  return { identifiers: identifiers(customerId ? { id: customerId } : undefined), billingPayment: { providerNamespace: STRIPE_PROVIDER, providerPaymentId: payment.id, providerCustomerId: customerId, providerSubscriptionId: subscriptionId, providerInvoiceId: invoiceId, status: payment.status ?? 'unknown', amount: amount(payment.amount_received ?? payment.amount), currency: String(payment.currency ?? 'usd').toUpperCase(), failureCode: payment.last_payment_error?.code, failureMessage: payment.last_payment_error?.message, succeededAt: succeeded ? observed(payment) : undefined, failedAt: failed ? observed(payment) : undefined, sourceUpdatedAt: observed(payment) }, observedAt: observed(payment) };
}

export function mapStripeAdjustment(adjustment: StripeObject): NormalizedRecord {
  const customerId = idOf(adjustment.customer); const chargeId = idOf(adjustment.charge); const paymentIntentId = idOf(adjustment.payment_intent); const invoiceId = idOf(adjustment.invoice);
  return { identifiers: identifiers(customerId ? { id: customerId } : undefined), billingAdjustment: { providerNamespace: STRIPE_PROVIDER, providerAdjustmentId: adjustment.id, providerCustomerId: customerId, providerPaymentId: paymentIntentId ?? chargeId, providerInvoiceId: invoiceId, status: adjustment.status ?? 'succeeded', amount: amount(adjustment.amount), currency: String(adjustment.currency ?? 'usd').toUpperCase(), occurredAt: observed(adjustment), sourceUpdatedAt: observed(adjustment) }, observedAt: observed(adjustment) };
}

export function mapStripeWebhook(type: string, object: StripeObject, eventObservedAt?: string): NormalizedRecord[] | null {
  let records: NormalizedRecord[] | null = null;
  if (type.startsWith('customer.') && !type.includes('subscription')) records = object.deleted ? null : [mapStripeCustomer(object)];
  else if (type.startsWith('customer.subscription.')) records = [mapStripeSubscription(object)];
  else if (type.startsWith('invoice.')) records = [mapStripeInvoice(object)];
  else if (type.startsWith('payment_intent.')) records = [mapStripePayment(object)];
  else if (type === 'charge.refunded' || type === 'refund.created') records = [mapStripeAdjustment(object)];
  if (!records || !eventObservedAt) return records;
  // Stripe object `created` is immutable. Webhook event `created` is therefore
  // the only reliable source-order timestamp for a later status transition.
  return records.map((record) => ({ ...record, observedAt: eventObservedAt, billingSubscription: record.billingSubscription && { ...record.billingSubscription, sourceUpdatedAt: eventObservedAt }, billingInvoice: record.billingInvoice && { ...record.billingInvoice, sourceUpdatedAt: eventObservedAt }, billingPayment: record.billingPayment && { ...record.billingPayment, sourceUpdatedAt: eventObservedAt }, billingAdjustment: record.billingAdjustment && { ...record.billingAdjustment, sourceUpdatedAt: eventObservedAt } }));
}
