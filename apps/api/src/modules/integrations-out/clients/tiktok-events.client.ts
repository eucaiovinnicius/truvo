import { Injectable } from '@nestjs/common';
import type { IntegrationOutConfigJson } from '@truvo/db';
import {
  TIKTOK_API_VERSION,
  TIKTOK_EVENT_NAMES,
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
 * TikTok Events API — envio server-side (PRD §7 M9).
 *
 * POST https://business-api.tiktok.com/open_api/<ver>/event/track/
 * Header: Access-Token: <token>
 * Body: { event_source:'web', event_source_id:<pixel_code>, test_event_code?,
 *   data:[{ event, event_time, event_id, user:{ email:[sha256], phone:[sha256],
 *   ttclid, ip, user_agent, external_id }, properties:{ currency, value } }] }
 *
 * Dedup: `event_id` casa com o pixel do browser. Email/telefone já vão SHA-256.
 *
 * // TODO(live): requer acesso à TikTok Marketing API e um long-lived
 * // `credentials.access_token`.
 */
@Injectable()
export class TikTokEventsClient implements ConversionClient {
  readonly platform = 'tiktok_events' as const;

  platformEventName(canonical: CanonicalConversion): string | undefined {
    return TIKTOK_EVENT_NAMES[canonical];
  }

  private endpoint(): string {
    return `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}/event/track/`;
  }

  async send(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
    conversion: NormalizedConversion,
    opts: { test: boolean },
  ): Promise<PlatformSendResult> {
    const accessToken = creds.access_token;
    if (!accessToken || !config.pixel_code) {
      return { ok: false, error: 'tiktok: access_token e pixel_code são obrigatórios' };
    }
    const eventName = this.platformEventName(conversion.canonical);
    if (!eventName) return { ok: false, error: 'tiktok: conversão não mapeada' };

    const mk = conversion.matchKeys;
    const ttclid = mk.ttclid ?? mk.clickId;
    const user: Record<string, unknown> = {};
    if (mk.emailHash) user.email = [mk.emailHash];
    if (mk.phoneHash) user.phone = [mk.phoneHash];
    if (ttclid) user.ttclid = ttclid;
    if (mk.ip) user.ip = mk.ip; // não persistido (regra 5)
    if (mk.userAgent) user.user_agent = mk.userAgent;
    if (mk.externalId) user.external_id = [mk.externalId];

    const properties: Record<string, unknown> = {};
    if (conversion.value != null) properties.value = conversion.value;
    if (conversion.currency) properties.currency = conversion.currency;
    if (conversion.orderId) properties.order_id = conversion.orderId;

    const eventData: Record<string, unknown> = {
      event: eventName,
      event_time: Math.floor(conversion.eventTimeMs / 1000),
      event_id: conversion.eventId, // dedup pixel+Events API
      user,
      properties,
    };
    if (conversion.sourceUrl) {
      eventData.page = { url: conversion.sourceUrl };
    }

    const payload: Record<string, unknown> = {
      event_source: 'web',
      event_source_id: config.pixel_code,
      data: [eventData],
    };
    if (config.test_event_code) payload.test_event_code = config.test_event_code;

    try {
      const res = await postJson(this.endpoint(), payload, { 'Access-Token': accessToken });
      // A TikTok responde 200 com { code, message }; code !== 0 é erro lógico.
      const body = res.body as Record<string, unknown> | undefined;
      const logicalCode = body && typeof body.code === 'number' ? body.code : undefined;
      const ok = res.ok && (logicalCode === undefined || logicalCode === 0);
      if (!ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: errorMessage(res.body, 'tiktok: envio rejeitado'),
          response: summarize(res.body),
        };
      }
      return { ok: true, httpStatus: res.status, response: summarize(res.body) };
    } catch (e) {
      return { ok: false, error: `tiktok: ${(e as Error).message}` };
    }
  }

  async ping(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
  ): Promise<PlatformPingResult> {
    const checks = {
      access_token: Boolean(creds.access_token),
      pixel_code: Boolean(config.pixel_code),
    };
    const ok = checks.access_token && checks.pixel_code;
    // A TikTok não tem GET de validação barato universal; validação estrutural +
    // (opcional) um evento de teste via POST /:platform/test. // TODO(live): usar
    // test_event_code no Events Manager para validação ponta-a-ponta.
    return {
      ok,
      checks,
      message: ok
        ? 'tiktok: credenciais presentes (validação estrutural — use POST test p/ ponta-a-ponta)'
        : 'tiktok: faltam access_token e/ou pixel_code',
    };
  }
}

function summarize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const o = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('code' in o) out.code = o.code;
  if ('message' in o) out.message = o.message;
  if ('request_id' in o) out.request_id = o.request_id;
  return out;
}
