import { INTEGRATION_OUT_PLATFORMS, type IntegrationOutPlatform } from '@truvo/db';

/**
 * M9 — EXTERNAL INTEGRATIONS (saída) · constantes, tokens de DI e mapeamentos.
 *
 * Toda a saída respeita:
 *  · regra 13 — só envia PII a terceiros com consentimento/base legal (fail-closed);
 *  · regra 4/5/7 — email/telefone só como hash; IP nunca persistido; segredos cifrados;
 *  · dedup por `event_id` — MESMO id do pixel, para a plataforma não contar 2x.
 */

/** Token de DI para a conexão Drizzle (Postgres/Supabase) do módulo. */
export const INTEGRATIONS_OUT_DB = 'INTEGRATIONS_OUT_DB';

/**
 * Token de DI do registry de clients por plataforma. O forwarder e o controller
 * injetam este mapa (plataforma → client). Fácil de mockar em teste.
 */
export const CONVERSION_CLIENTS = Symbol('CONVERSION_CLIENTS');

export { INTEGRATION_OUT_PLATFORMS };
export type { IntegrationOutPlatform };

/**
 * Conversões CANÔNICAS que sabemos enviar (PRD §7 M9): purchase, lead,
 * InitiateCheckout, CompleteRegistration. Cada plataforma tem seu nome próprio.
 */
export const CANONICAL_CONVERSIONS = [
  'purchase',
  'lead',
  'initiate_checkout',
  'complete_registration',
] as const;
export type CanonicalConversion = (typeof CANONICAL_CONVERSIONS)[number];

/**
 * Mapa DEFAULT: nome do evento Truvo (@truvo/event-schema STANDARD_EVENTS + comuns)
 * → conversão canônica. `config.event_map` do workspace sobrescreve (ou 'ignore').
 * Eventos ausentes deste mapa não são encaminhados (skipped_unmapped).
 */
export const DEFAULT_EVENT_MAP: Record<string, CanonicalConversion> = {
  purchase: 'purchase',
  checkout_completed: 'purchase',
  subscription_started: 'purchase',
  lead: 'lead',
  checkout_started: 'initiate_checkout',
  complete_registration: 'complete_registration',
  registration_completed: 'complete_registration',
  sign_up: 'complete_registration',
};

/** Nome do evento na Meta Conversions API por conversão canônica. */
export const META_EVENT_NAMES: Record<CanonicalConversion, string> = {
  purchase: 'Purchase',
  lead: 'Lead',
  initiate_checkout: 'InitiateCheckout',
  complete_registration: 'CompleteRegistration',
};

/** Nome do evento na TikTok Events API por conversão canônica. */
export const TIKTOK_EVENT_NAMES: Record<CanonicalConversion, string> = {
  purchase: 'CompletePayment',
  lead: 'SubmitForm',
  initiate_checkout: 'InitiateCheckout',
  complete_registration: 'CompleteRegistration',
};

/**
 * Nome-base do Custom Behavioral Event no HubSpot por conversão canônica.
 * O client prefixa com `pe<portalId>_` quando `config.portal_id` está presente.
 * `config.hubspot_events` sobrescreve por conversão.
 */
export const HUBSPOT_EVENT_NAMES: Record<CanonicalConversion, string> = {
  purchase: 'truvo_purchase',
  lead: 'truvo_lead',
  initiate_checkout: 'truvo_initiate_checkout',
  complete_registration: 'truvo_complete_registration',
};

/** Versão default da Graph API da Meta (sobrescrevível por config.graph_version). */
export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v19.0';

/** Versão default da Google Ads API. */
export const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? 'v17';

/** Versão default da TikTok Business API. */
export const TIKTOK_API_VERSION = process.env.TIKTOK_API_VERSION ?? 'v1.3';

/** Timeout (ms) das chamadas HTTP às plataformas (fetch nativo + AbortController). */
export const OUTBOUND_HTTP_TIMEOUT_MS = Number(process.env.OUTBOUND_HTTP_TIMEOUT_MS ?? 8000);

/**
 * Resolve nome do evento Truvo → conversão canônica, aplicando o override do
 * workspace. Retorna `undefined` quando não mapeado ou explicitamente 'ignore'.
 */
export function resolveCanonical(
  eventName: string,
  overrides?: Record<string, string>,
): CanonicalConversion | undefined {
  const override = overrides?.[eventName];
  if (override) {
    if (override === 'ignore') return undefined;
    return (CANONICAL_CONVERSIONS as readonly string[]).includes(override)
      ? (override as CanonicalConversion)
      : undefined;
  }
  return DEFAULT_EVENT_MAP[eventName];
}
