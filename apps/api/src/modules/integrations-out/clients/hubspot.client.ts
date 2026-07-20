import { Injectable } from '@nestjs/common';
import type { IntegrationOutConfigJson } from '@truvo/db';
import {
  HUBSPOT_EVENT_NAMES,
  OUTBOUND_HTTP_TIMEOUT_MS,
  type CanonicalConversion,
} from '../integrations-out.constants';
import { errorMessage, postJson } from './http';
import type {
  ConversionClient,
  DecryptedCredentials,
  NormalizedConversion,
  PlatformPingResult,
  PlatformSendResult,
} from './types';

/**
 * HubSpot — envio server-side de conversões como Custom Behavioral Events (PRD §7 M9).
 *
 * POST https://api.hubapi.com/events/v3/send  (Bearer <access_token>)
 * Body: { eventName: 'pe<portalId>_<evento>', objectId, occurredAt, properties }
 *
 * Serve para gravar a conversão/atribuição real dentro do CRM do cliente (o time de
 * vendas/marketing vê no contato o ROAS/LTV que o Truvo calcula).
 *
 * Identidade: o HubSpot casa o contato por email EM CLARO, objectId ou utk. O Truvo
 * guarda apenas email_hash (regra 4) — usamos o `objectId` do contato quando presente
 * nas match keys (external_id). // TODO(live): resolver contato por email em claro
 * (com consentimento) ou mapear o objectId do HubSpot na entrada (webhook de CRM).
 *
 * // TODO(live): requer Private App token (ou OAuth) com escopo
 * // `behavioral_events.event_definitions.read_write` + a definição de evento criada.
 */
@Injectable()
export class HubspotClient implements ConversionClient {
  readonly platform = 'hubspot' as const;

  platformEventName(canonical: CanonicalConversion): string | undefined {
    return HUBSPOT_EVENT_NAMES[canonical];
  }

  private eventName(
    config: IntegrationOutConfigJson,
    canonical: CanonicalConversion,
  ): string | undefined {
    const base = config.hubspot_events?.[canonical] ?? this.platformEventName(canonical);
    if (!base) return undefined;
    // Eventos comportamentais custom usam o prefixo pe<portalId>_ quando há portal.
    return config.portal_id ? `pe${config.portal_id}_${base}` : base;
  }

  async send(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
    conversion: NormalizedConversion,
    _opts: { test: boolean },
  ): Promise<PlatformSendResult> {
    const token = creds.access_token;
    if (!token) return { ok: false, error: 'hubspot: access_token é obrigatório' };

    const eventName = this.eventName(config, conversion.canonical);
    if (!eventName) return { ok: false, error: 'hubspot: conversão não mapeada' };

    const objectId = conversion.matchKeys.externalId;
    if (!objectId) {
      // Sem identificador de contato do HubSpot não há como casar (Truvo não envia
      // e-mail em claro). Melhor pular do que enviar sem identidade.
      return {
        ok: false,
        error: 'hubspot: sem objectId/utk do contato (Truvo guarda email como hash)',
      };
    }

    const properties: Record<string, unknown> = {};
    if (conversion.value != null) properties.value = conversion.value;
    if (conversion.currency) properties.currency = conversion.currency;
    if (conversion.orderId) properties.order_id = conversion.orderId;

    const payload: Record<string, unknown> = {
      eventName,
      objectId,
      occurredAt: new Date(conversion.eventTimeMs).toISOString(),
      properties,
    };

    try {
      const res = await postJson('https://api.hubapi.com/events/v3/send', payload, {
        authorization: `Bearer ${token}`,
      });
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: errorMessage(res.body, 'hubspot: envio rejeitado'),
          response: summarize(res.body),
        };
      }
      return { ok: true, httpStatus: res.status, response: summarize(res.body) };
    } catch (e) {
      return { ok: false, error: `hubspot: ${(e as Error).message}` };
    }
  }

  async ping(
    creds: DecryptedCredentials,
    _config: IntegrationOutConfigJson,
  ): Promise<PlatformPingResult> {
    const checks: Record<string, boolean> = { access_token: Boolean(creds.access_token) };
    if (!checks.access_token) {
      return { ok: false, checks, message: 'hubspot: falta access_token' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OUTBOUND_HTTP_TIMEOUT_MS);
      const res = await fetch('https://api.hubapi.com/account-info/v3/details', {
        headers: { authorization: `Bearer ${creds.access_token!}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      checks['token_valid'] = res.ok;
      return {
        ok: res.ok,
        httpStatus: res.status,
        checks,
        message: res.ok
          ? 'hubspot: token válido (conta acessível)'
          : `hubspot: ${errorMessage(body, 'token inválido')}`,
      };
    } catch (e) {
      checks['token_valid'] = false;
      return { ok: false, checks, message: `hubspot: ${(e as Error).message}` };
    }
  }
}

/** Extrai só campos não-PII da resposta do HubSpot. */
function summarize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const o = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('status' in o) out.status = o.status;
  if ('message' in o) out.message = o.message;
  if ('correlationId' in o) out.correlationId = o.correlationId;
  if ('category' in o) out.category = o.category;
  return out;
}
