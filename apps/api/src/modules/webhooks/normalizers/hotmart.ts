import { hashEmail } from '../crypto/hash';
import { num, pick, str, type Normalized, type ProviderPayload } from './types';

/**
 * Hotmart (PRD §7 M4):
 *   purchase.complete  → purchase
 *   purchase.refunded  → refund
 * A Hotmart usa `event` no envelope (ex.: `PURCHASE_COMPLETE`) e os dados em `data`.
 * // TODO(live): confirmar nomes de evento/campos da versão do webhook Hotmart v2.
 */
const EVENT_MAP: Record<string, string> = {
  'purchase.complete': 'purchase',
  purchase_complete: 'purchase',
  purchase_approved: 'purchase',
  'purchase.refunded': 'refund',
  purchase_refunded: 'refund',
  purchase_canceled: 'refund',
};

export function hotmartEventType(payload: ProviderPayload): string {
  return str(pick(payload, 'event') ?? pick(pick(payload, 'data'), 'event')) ?? 'unknown';
}

export function normalizeHotmart(payload: ProviderPayload): Normalized | null {
  const rawEvent = hotmartEventType(payload);
  const eventName = EVENT_MAP[rawEvent] ?? EVENT_MAP[rawEvent.toLowerCase()];
  if (!eventName) return null;

  const data = pick(payload, 'data') ?? payload;
  const purchase = pick(data, 'purchase') ?? {};
  const buyer = pick(data, 'buyer') ?? {};
  const product = pick(data, 'product') ?? {};
  const price = pick(purchase, 'price') ?? pick(purchase, 'full_price') ?? {};
  const orderDate = pick(purchase, 'order_date') ?? pick(purchase, 'approved_date');

  return {
    event_name: eventName,
    provider_event: rawEvent,
    order_id: str(pick(purchase, 'transaction') ?? pick(data, 'transaction')),
    timestamp: orderDate ? new Date(num(orderDate)).toISOString() : undefined,
    properties: {
      value: num(pick(price, 'value')),
      currency: str(pick(price, 'currency_value') ?? pick(price, 'currency_code')) ?? 'BRL',
      product_id: str(pick(product, 'id')),
      email_hash: hashEmail(str(pick(buyer, 'email'))),
    },
    context: {},
  };
}
