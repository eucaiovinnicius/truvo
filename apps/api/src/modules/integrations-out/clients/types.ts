import type { IntegrationOutConfigJson, IntegrationOutPlatform } from '@truvo/db';
import type { CanonicalConversion } from '../integrations-out.constants';
import type { NormalizedMatchKeys } from '../match-keys';

/**
 * M9 — contrato dos clients de plataforma (Meta/Google/TikTok).
 *
 * Cada client faz fetch NATIVO (sem SDK). Recebe as credenciais JÁ decifradas + a
 * config não-secreta + a conversão normalizada, e devolve um resultado estruturado
 * (nunca lança para o forwarder — erros viram `ok:false` para serem logados).
 */

/** Conversão normalizada, pronta para envio (sem PII em claro além das match keys). */
export interface NormalizedConversion {
  /** event_id do Truvo — dedup pixel+CAPI e idempotência. */
  eventId: string;
  /** Evento Truvo de origem (purchase/lead/…). */
  eventName: string;
  /** Conversão canônica resolvida. */
  canonical: CanonicalConversion;
  /** Instante do evento (epoch ms). */
  eventTimeMs: number;
  /** Valor e moeda da conversão (opcionais para lead/registration). */
  value?: number;
  currency?: string;
  /** URL de origem (event_source_url da Meta), quando disponível. */
  sourceUrl?: string;
  /** order_id — usado como order_id/content e reforço de dedup. */
  orderId?: string;
  matchKeys: NormalizedMatchKeys;
}

/** Resultado do envio de UMA conversão a UMA plataforma. */
export interface PlatformSendResult {
  ok: boolean;
  httpStatus?: number;
  /** Resposta resumida e SEM PII (fbtrace_id, events_received, request_id…). */
  response?: Record<string, unknown>;
  error?: string;
}

/** Resultado de um health-check/validação de credenciais (GET status / POST test). */
export interface PlatformPingResult {
  ok: boolean;
  httpStatus?: number;
  message: string;
  /** Checks estruturais (credenciais presentes, config mínima, etc.). */
  checks: Record<string, boolean>;
}

export interface DecryptedCredentials {
  [key: string]: string | undefined;
}

/** Client de conversão de uma plataforma. */
export interface ConversionClient {
  readonly platform: IntegrationOutPlatform;

  /** Nome do evento na plataforma p/ a conversão canônica (undefined = não suportado). */
  platformEventName(canonical: CanonicalConversion): string | undefined;

  /** Envia UMA conversão. Nunca lança — encapsula erros em `ok:false`. */
  send(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
    conversion: NormalizedConversion,
    opts: { test: boolean },
  ): Promise<PlatformSendResult>;

  /**
   * Valida credenciais/config sem enviar conversão real (ou com test_event_code).
   * Usado por GET status e POST test.
   */
  ping(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
  ): Promise<PlatformPingResult>;
}
