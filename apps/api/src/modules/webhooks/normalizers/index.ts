import type { WebhookProvider } from '../constants';
import { normalizeHotmart, hotmartEventType } from './hotmart';
import { normalizeHubspot, hubspotEventType } from './hubspot';
import { normalizeKiwify, kiwifyEventType } from './kiwify';
import { normalizeShopify, shopifyEventType } from './shopify';
import { normalizeStripe, stripeEventType } from './stripe';
import type { Normalized, ProviderHeaders, ProviderPayload } from './types';

export * from './types';

/**
 * Normaliza o payload de um provedor para o EventSchema padrão.
 * Retorna `null` quando o evento do provedor não mapeia para um evento do Truvo
 * (nesse caso o webhook é logado como `received`/ignorado, mas ACK 200).
 */
export function normalize(
  provider: WebhookProvider,
  payload: ProviderPayload,
  headers: ProviderHeaders,
): Normalized | null {
  switch (provider) {
    case 'shopify':
      return normalizeShopify(payload, headers);
    case 'stripe':
      return normalizeStripe(payload);
    case 'hotmart':
      return normalizeHotmart(payload);
    case 'kiwify':
      return normalizeKiwify(payload);
    case 'hubspot':
      return normalizeHubspot(payload, headers);
    default:
      return null;
  }
}

/** Melhor-esforço para extrair o tipo de evento do provedor (para logs). */
export function providerEventType(
  provider: WebhookProvider,
  payload: ProviderPayload,
  headers: ProviderHeaders,
): string {
  switch (provider) {
    case 'shopify':
      return shopifyEventType(headers);
    case 'stripe':
      return stripeEventType(payload);
    case 'hotmart':
      return hotmartEventType(payload);
    case 'kiwify':
      return kiwifyEventType(payload);
    case 'hubspot':
      return hubspotEventType(payload);
    default:
      return 'unknown';
  }
}
