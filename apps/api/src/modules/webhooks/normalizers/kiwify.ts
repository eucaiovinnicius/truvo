import { hashEmail } from '../crypto/hash';
import { num, pick, str, type Normalized, type ProviderPayload } from './types';

/**
 * Kiwify (PRD §7 M4):
 *   order.paid      → purchase
 *   order.refunded  → refund
 * A Kiwify sinaliza o evento em `webhook_event_type` e/ou `order_status`.
 * // TODO(live): confirmar nomes de evento/campos da doc atual da Kiwify.
 */
const EVENT_MAP: Record<string, string> = {
  'order.paid': 'purchase',
  order_approved: 'purchase',
  paid: 'purchase',
  approved: 'purchase',
  'order.refunded': 'refund',
  order_refunded: 'refund',
  refunded: 'refund',
  chargeback: 'refund',
};

export function kiwifyEventType(payload: ProviderPayload): string {
  return (
    str(
      pick(payload, 'webhook_event_type') ??
        pick(payload, 'order_status') ??
        pick(payload, 'event'),
    ) ?? 'unknown'
  );
}

export function normalizeKiwify(payload: ProviderPayload): Normalized | null {
  const rawEvent = kiwifyEventType(payload);
  const eventName = EVENT_MAP[rawEvent] ?? EVENT_MAP[rawEvent.toLowerCase()];
  if (!eventName) return null;

  const order = pick(payload, 'order') ?? payload;
  const customer = pick(payload, 'Customer') ?? pick(payload, 'customer') ?? {};
  const commissions = pick(payload, 'Commissions') ?? {};
  const product = pick(payload, 'Product') ?? pick(payload, 'product') ?? {};
  const amountCents =
    pick(commissions, 'charge_amount') ??
    pick(order, 'charge_amount') ??
    pick(payload, 'charge_amount');

  return {
    event_name: eventName,
    provider_event: rawEvent,
    order_id: str(pick(order, 'order_id') ?? pick(payload, 'order_id') ?? pick(payload, 'id')),
    timestamp: str(pick(order, 'created_at') ?? pick(payload, 'created_at')) ?? undefined,
    properties: {
      // Kiwify envia charge_amount em centavos.
      value: num(amountCents) / 100,
      currency: str(pick(order, 'currency') ?? pick(payload, 'currency')) ?? 'BRL',
      product_id: str(pick(product, 'id')),
      email_hash: hashEmail(str(pick(customer, 'email'))),
    },
    context: {},
  };
}
