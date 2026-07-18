import { hashEmail } from '../crypto/hash';
import { num, pick, str, type Normalized, type ProviderPayload } from './types';

/**
 * Stripe (PRD §7 M4):
 *   payment_intent.succeeded       → purchase
 *   charge.refunded                → refund
 *   customer.subscription.created  → subscription_started
 *   customer.subscription.deleted  → subscription_cancelled
 *   invoice.paid                   → payment_received
 * O tipo vem no campo `type` do evento; o objeto em `data.object`.
 * Valores monetários da Stripe vêm em centavos → dividir por 100.
 */
const TYPE_MAP: Record<string, string> = {
  'payment_intent.succeeded': 'purchase',
  'charge.refunded': 'refund',
  'customer.subscription.created': 'subscription_started',
  'customer.subscription.deleted': 'subscription_cancelled',
  'invoice.paid': 'payment_received',
};

export function stripeEventType(payload: ProviderPayload): string {
  return str(pick(payload, 'type')) ?? 'unknown';
}

export function normalizeStripe(payload: ProviderPayload): Normalized | null {
  const type = stripeEventType(payload);
  const eventName = TYPE_MAP[type];
  if (!eventName) return null;

  const obj = pick(pick(payload, 'data'), 'object') ?? {};
  const amountCents =
    pick(obj, 'amount') ?? pick(obj, 'amount_paid') ?? pick(obj, 'amount_received') ?? 0;
  const email =
    (pick(obj, 'receipt_email') as string) ?? (pick(obj, 'customer_email') as string);
  const createdUnix = num(pick(payload, 'created'));

  return {
    event_name: eventName,
    provider_event: type,
    order_id: str(pick(obj, 'id') ?? pick(payload, 'id')),
    timestamp: createdUnix ? new Date(createdUnix * 1000).toISOString() : undefined,
    properties: {
      value: num(amountCents) / 100,
      currency: (str(pick(obj, 'currency')) ?? 'brl').toUpperCase(),
      customer_id: str(pick(obj, 'customer')),
      subscription_id: str(pick(obj, 'subscription')),
      email_hash: hashEmail(email),
    },
    context: {},
  };
}
