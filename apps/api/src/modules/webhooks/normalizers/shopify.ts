import { hashEmail } from '../crypto/hash';
import { num, pick, str, type Normalized, type ProviderHeaders, type ProviderPayload } from './types';

/**
 * Shopify (PRD §7 M4):
 *   orders/paid        → purchase
 *   orders/refunded    → refund
 *   checkouts/create   → checkout_started
 *   checkouts/complete → checkout_completed
 * O tópico chega no header `X-Shopify-Topic`.
 * // TODO(live): validar nomes de campos contra a doc atual da Shopify Admin API.
 */
const TOPIC_MAP: Record<string, string> = {
  'orders/paid': 'purchase',
  'orders/refunded': 'refund',
  'checkouts/create': 'checkout_started',
  'checkouts/complete': 'checkout_completed',
};

export function shopifyEventType(headers: ProviderHeaders): string {
  return headers['x-shopify-topic'] ?? 'unknown';
}

export function normalizeShopify(
  payload: ProviderPayload,
  headers: ProviderHeaders,
): Normalized | null {
  const topic = shopifyEventType(headers);
  const eventName = TOPIC_MAP[topic];
  if (!eventName) return null;

  const customer = pick(payload, 'customer');
  const email = (pick(payload, 'email') as string) ?? (pick(customer, 'email') as string);
  const lineItems = pick(payload, 'line_items');
  const items = Array.isArray(lineItems)
    ? lineItems.map((li) => ({
        id: str(pick(li, 'product_id') ?? pick(li, 'id')),
        name: str(pick(li, 'title')),
        price: num(pick(li, 'price')),
        quantity: num(pick(li, 'quantity'), 1),
      }))
    : [];

  return {
    event_name: eventName,
    provider_event: topic,
    order_id: str(pick(payload, 'id') ?? pick(payload, 'order_id')),
    timestamp: (str(pick(payload, 'processed_at') ?? pick(payload, 'created_at')) ?? undefined),
    properties: {
      value: num(pick(payload, 'total_price') ?? pick(payload, 'current_total_price')),
      currency: str(pick(payload, 'currency') ?? pick(payload, 'presentment_currency')) ?? 'BRL',
      items,
      customer_id: str(pick(customer, 'id')),
      email_hash: hashEmail(email),
    },
    context: {
      utm_source: str(pick(payload, 'source_name')),
      referrer: str(pick(payload, 'referring_site')),
      landing_page: str(pick(payload, 'landing_site')),
    },
  };
}
