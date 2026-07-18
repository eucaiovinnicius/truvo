import { Injectable } from '@nestjs/common';
import type { IntegrationOutConfigJson } from '@truvo/db';
import {
  META_EVENT_NAMES,
  META_GRAPH_VERSION,
  type CanonicalConversion,
} from '../integrations-out.constants';
import { buildFbc } from '../match-keys';
import { errorMessage, postJson } from './http';
import type {
  ConversionClient,
  DecryptedCredentials,
  NormalizedConversion,
  PlatformPingResult,
  PlatformSendResult,
} from './types';

/**
 * Meta Conversions API (CAPI) — envio server-side (PRD §7 M9).
 *
 * POST https://graph.facebook.com/<ver>/<pixel_id>/events?access_token=<token>
 * Body: { data: [{ event_name, event_time, event_id, action_source:'website',
 *   event_source_url, user_data:{ em, ph, client_ip_address, client_user_agent,
 *   fbc, fbp, external_id }, custom_data:{ currency, value } }], test_event_code? }
 *
 * Dedup: `event_id` é o MESMO usado pelo pixel do browser → a Meta descarta a dupla
 * contagem pixel+CAPI. Email/telefone já vão como SHA-256 (regra 4).
 *
 * // TODO(live): requer Business Verification + App Review (ads_read/CAPI) e um
 * // system-user access token de longa duração no `credentials.access_token`.
 */
@Injectable()
export class MetaCapiClient implements ConversionClient {
  readonly platform = 'meta_capi' as const;

  platformEventName(canonical: CanonicalConversion): string | undefined {
    return META_EVENT_NAMES[canonical];
  }

  private endpoint(config: IntegrationOutConfigJson, accessToken: string): string {
    const version = config.graph_version || META_GRAPH_VERSION;
    const pixelId = config.pixel_id ?? '';
    return `https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
  }

  async send(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
    conversion: NormalizedConversion,
    opts: { test: boolean },
  ): Promise<PlatformSendResult> {
    const accessToken = creds.access_token;
    if (!accessToken || !config.pixel_id) {
      return { ok: false, error: 'meta: access_token e pixel_id são obrigatórios' };
    }
    const eventName = this.platformEventName(conversion.canonical);
    if (!eventName) return { ok: false, error: 'meta: conversão não mapeada' };

    const mk = conversion.matchKeys;
    const fbclid = mk.fbclid ?? mk.clickId;
    const userData: Record<string, unknown> = {};
    if (mk.emailHash) userData.em = [mk.emailHash];
    if (mk.phoneHash) userData.ph = [mk.phoneHash];
    if (mk.ip) userData.client_ip_address = mk.ip; // não persistido (regra 5)
    if (mk.userAgent) userData.client_user_agent = mk.userAgent;
    if (mk.externalId) userData.external_id = [mk.externalId];
    const fbc = buildFbc(fbclid, conversion.eventTimeMs);
    if (fbc) userData.fbc = fbc;
    if (mk.fbp) userData.fbp = mk.fbp;

    const customData: Record<string, unknown> = {};
    if (conversion.value != null) customData.value = conversion.value;
    if (conversion.currency) customData.currency = conversion.currency;
    if (conversion.orderId) customData.order_id = conversion.orderId;

    const eventPayload: Record<string, unknown> = {
      event_name: eventName,
      event_time: Math.floor(conversion.eventTimeMs / 1000), // epoch segundos
      event_id: conversion.eventId, // dedup pixel+CAPI
      action_source: 'website',
      user_data: userData,
      custom_data: customData,
    };
    if (conversion.sourceUrl) eventPayload.event_source_url = conversion.sourceUrl;

    const payload: Record<string, unknown> = { data: [eventPayload] };
    const testCode = opts.test ? config.test_event_code : config.test_event_code;
    if (testCode) payload.test_event_code = testCode;

    try {
      const res = await postJson(this.endpoint(config, accessToken), payload);
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: errorMessage(res.body, 'meta: envio rejeitado'),
          response: summarize(res.body),
        };
      }
      return { ok: true, httpStatus: res.status, response: summarize(res.body) };
    } catch (e) {
      return { ok: false, error: `meta: ${(e as Error).message}` };
    }
  }

  async ping(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
  ): Promise<PlatformPingResult> {
    const checks: Record<string, boolean> = {
      access_token: Boolean(creds.access_token),
      pixel_id: Boolean(config.pixel_id),
    };
    if (!checks.access_token || !checks.pixel_id) {
      return {
        ok: false,
        checks,
        message: 'meta: faltam access_token e/ou pixel_id',
      };
    }
    // Valida o par (token, pixel) lendo o próprio pixel via Graph API (sem enviar
    // conversão). GET /<pixel_id>?fields=id
    const version = config.graph_version || META_GRAPH_VERSION;
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(config.pixel_id!)}?fields=id&access_token=${encodeURIComponent(creds.access_token!)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      checks['pixel_reachable'] = res.ok;
      return {
        ok: res.ok,
        httpStatus: res.status,
        checks,
        message: res.ok
          ? 'meta: credenciais válidas (pixel acessível)'
          : `meta: ${errorMessage(body, 'pixel inacessível')}`,
      };
    } catch (e) {
      checks['pixel_reachable'] = false;
      return { ok: false, checks, message: `meta: ${(e as Error).message}` };
    }
  }
}

/** Extrai só campos não-PII da resposta da Meta. */
function summarize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const o = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('events_received' in o) out.events_received = o.events_received;
  if ('messages' in o) out.messages = o.messages;
  if ('fbtrace_id' in o) out.fbtrace_id = o.fbtrace_id;
  if ('error' in o && o.error && typeof o.error === 'object') {
    const e = o.error as Record<string, unknown>;
    out.error = { message: e.message, code: e.code, fbtrace_id: e.fbtrace_id };
  }
  return out;
}
