import { Injectable } from '@nestjs/common';
import type { IntegrationOutConfigJson } from '@truvo/db';
import {
  GOOGLE_ADS_API_VERSION,
  type CanonicalConversion,
} from '../integrations-out.constants';
import { errorMessage, postForm, postJson } from './http';
import type {
  ConversionClient,
  DecryptedCredentials,
  NormalizedConversion,
  PlatformPingResult,
  PlatformSendResult,
} from './types';

/**
 * Google Enhanced Conversions via Google Ads API — Offline Conversion Import
 * (PRD §7 M9). Faz upload de click conversions com gclid + email/telefone hash.
 *
 * Fluxo:
 *  1. troca refresh_token → access_token (OAuth2, POST oauth2.googleapis.com/token);
 *  2. POST customers/<customer_id>:uploadClickConversions com headers
 *     `developer-token`, `login-customer-id` (MCC) e `Authorization: Bearer`.
 *
 * Campos: conversion_action (resource), conversion_date_time, conversion_value,
 * currency_code, gclid, user_identifiers[{ hashed_email | hashed_phone_number }].
 *
 * // TODO(live): requer Developer Token (basic→standard), OAuth consent + refresh
 * // token do cliente, e o resource name da conversion action por conversão canônica
 * // em `config.conversion_actions`.
 */
@Injectable()
export class GoogleEnhancedClient implements ConversionClient {
  readonly platform = 'google_enhanced' as const;

  /** O Google não usa nome de evento — a conversão é o conversionAction configurado. */
  platformEventName(canonical: CanonicalConversion): string | undefined {
    return canonical; // rótulo lógico; a resolução real é via config.conversion_actions
  }

  /** Resolve o resource name da conversion action para a conversão canônica. */
  private conversionAction(
    config: IntegrationOutConfigJson,
    canonical: CanonicalConversion,
  ): string | undefined {
    return config.conversion_actions?.[canonical] ?? config.conversion_action_id;
  }

  /** Troca refresh_token por access_token. Retorna undefined em falha. */
  private async accessToken(creds: DecryptedCredentials): Promise<string | undefined> {
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) return undefined;
    try {
      const res = await postForm('https://oauth2.googleapis.com/token', {
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      });
      const body = res.body as Record<string, unknown> | undefined;
      const token = body && typeof body.access_token === 'string' ? body.access_token : undefined;
      return token;
    } catch {
      return undefined;
    }
  }

  private uploadUrl(customerId: string): string {
    const cid = customerId.replace(/-/g, '');
    return `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(cid)}:uploadClickConversions`;
  }

  /** DateTime no formato exigido pelo Google Ads: 'YYYY-MM-DD HH:MM:SS+00:00'. */
  private formatDate(ms: number): string {
    const iso = new Date(ms).toISOString(); // 2026-07-15T12:00:00.000Z
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
  }

  async send(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
    conversion: NormalizedConversion,
    _opts: { test: boolean },
  ): Promise<PlatformSendResult> {
    if (!creds.developer_token || !config.customer_id) {
      return { ok: false, error: 'google: developer_token e customer_id são obrigatórios' };
    }
    const action = this.conversionAction(config, conversion.canonical);
    if (!action) {
      return { ok: false, error: 'google: conversion action não configurada para a conversão' };
    }
    const mk = conversion.matchKeys;
    const gclid = mk.gclid ?? mk.clickId;

    const userIdentifiers: Array<Record<string, unknown>> = [];
    if (mk.emailHash) userIdentifiers.push({ hashedEmail: mk.emailHash });
    if (mk.phoneHash) userIdentifiers.push({ hashedPhoneNumber: mk.phoneHash });

    const conv: Record<string, unknown> = {
      conversionAction: action,
      conversionDateTime: this.formatDate(conversion.eventTimeMs),
    };
    if (gclid) conv.gclid = gclid;
    if (conversion.value != null) conv.conversionValue = conversion.value;
    if (conversion.currency) conv.currencyCode = conversion.currency;
    if (conversion.orderId) conv.orderId = conversion.orderId;
    if (userIdentifiers.length) conv.userIdentifiers = userIdentifiers;

    const token = await this.accessToken(creds);
    if (!token) {
      return { ok: false, error: 'google: falha ao obter access_token (OAuth refresh)' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'developer-token': creds.developer_token,
    };
    if (config.login_customer_id) {
      headers['login-customer-id'] = config.login_customer_id.replace(/-/g, '');
    }

    const payload = {
      conversions: [conv],
      partialFailure: true,
    };

    try {
      const res = await postJson(this.uploadUrl(config.customer_id), payload, headers);
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: errorMessage(res.body, 'google: upload rejeitado'),
          response: summarize(res.body),
        };
      }
      // partialFailureError não-vazio = a conversão específica falhou.
      const body = res.body as Record<string, unknown> | undefined;
      const partial = body?.partialFailureError;
      if (partial) {
        return {
          ok: false,
          httpStatus: res.status,
          error: errorMessage(partial, 'google: partial failure'),
          response: summarize(res.body),
        };
      }
      return { ok: true, httpStatus: res.status, response: summarize(res.body) };
    } catch (e) {
      return { ok: false, error: `google: ${(e as Error).message}` };
    }
  }

  async ping(
    creds: DecryptedCredentials,
    config: IntegrationOutConfigJson,
  ): Promise<PlatformPingResult> {
    const checks: Record<string, boolean> = {
      developer_token: Boolean(creds.developer_token),
      oauth_credentials: Boolean(creds.client_id && creds.client_secret && creds.refresh_token),
      customer_id: Boolean(config.customer_id),
      conversion_action: Boolean(
        config.conversion_action_id ||
          (config.conversion_actions && Object.keys(config.conversion_actions).length > 0),
      ),
    };
    if (!checks.developer_token || !checks.oauth_credentials || !checks.customer_id) {
      return { ok: false, checks, message: 'google: faltam credenciais/config obrigatórias' };
    }
    // Valida o OAuth trocando o refresh_token por um access_token (sem enviar conversão).
    const token = await this.accessToken(creds);
    checks['oauth_refresh'] = Boolean(token);
    const ok = Boolean(token) && checks.conversion_action;
    return {
      ok,
      checks,
      message: ok
        ? 'google: OAuth válido e config completa'
        : token
          ? 'google: OAuth válido, mas falta conversion action'
          : 'google: falha no refresh do OAuth (credenciais inválidas)',
    };
  }
}

function summarize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const o = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('results' in o && Array.isArray(o.results)) out.results = o.results.length;
  if ('partialFailureError' in o && o.partialFailureError) {
    const e = o.partialFailureError as Record<string, unknown>;
    out.partial_failure = { message: e.message, code: e.code };
  }
  return out;
}
