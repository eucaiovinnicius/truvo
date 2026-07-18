import { createHash } from 'node:crypto';
import type { MatchKeyFlags } from '@truvo/db';

/**
 * M9 — MATCH KEYS (identificadores de correspondência) para envio server-side.
 *
 * As plataformas casam a conversão a um usuário via identificadores hasheados
 * (email/telefone SHA-256) + click ids (fbclid/gclid/ttclid) + external_id + IP +
 * user agent. Aqui normalizamos e hasheamos (regra 4/7). O IP pode ser usado como
 * match key mas NUNCA é persistido (regra 5) — só viaja no request de saída.
 *
 * Regra Meta/Google/TikTok: email/telefone devem ser SHA-256 (hex) do valor
 * normalizado (lowercase+trim para email; só dígitos com DDI para telefone E.164).
 */

const HEX_64 = /^[a-f0-9]{64}$/;

/** SHA-256 hex de uma string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Aceita e-mail em claro OU já hasheado. Normaliza (trim+lowercase) e hasheia se
 * ainda não for um SHA-256 hex. `undefined` quando vazio.
 */
export function normalizeEmailHash(input?: string | null): string | undefined {
  if (!input) return undefined;
  const v = input.trim().toLowerCase();
  if (!v) return undefined;
  if (HEX_64.test(v)) return v; // já é hash
  return sha256Hex(v);
}

/**
 * Telefone: aceita claro ou hash. Normaliza para dígitos (E.164 sem '+') e hasheia.
 * `undefined` quando vazio.
 */
export function normalizePhoneHash(input?: string | null): string | undefined {
  if (!input) return undefined;
  const raw = input.trim().toLowerCase();
  if (HEX_64.test(raw)) return raw; // já é hash
  const digits = input.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return sha256Hex(digits);
}

/**
 * `fbc` da Meta a partir do fbclid: `fb.1.<timestamp_ms>.<fbclid>`.
 * `eventTimeMs` é o instante do clique (usamos o do evento como aproximação).
 */
export function buildFbc(fbclid: string | undefined, eventTimeMs: number): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${eventTimeMs}.${fbclid}`;
}

/** Match keys já normalizadas prontas para os clients. */
export interface NormalizedMatchKeys {
  emailHash?: string;
  phoneHash?: string;
  /** click id genérico do evento (Truvo `click_id`, pode ser fbclid/gclid/ttclid). */
  clickId?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  /** cookie first-party _fbp da Meta, quando disponível. */
  fbp?: string;
  externalId?: string;
  ip?: string; // NUNCA persistir (regra 5)
  userAgent?: string;
}

/**
 * Pesos do proxy de Event Match Quality (0–10). Não é o EMQ real (a plataforma
 * calcula depois) — é um sinal local de cobertura para o monitor/alertas.
 */
const EMQ_WEIGHTS = {
  email: 3,
  phone: 2,
  clickId: 3,
  externalId: 1,
  ip: 0.5,
  userAgent: 0.5,
} as const;

export interface MatchQuality {
  /** 0–10 (proxy de cobertura). */
  score: number;
  count: number;
  flags: MatchKeyFlags;
}

/**
 * Avalia a cobertura de match keys de UMA plataforma (o click id relevante varia:
 * Meta=fbclid, Google=gclid, TikTok=ttclid). Retorna score/flags para logar.
 */
export function scoreMatchKeys(
  keys: NormalizedMatchKeys,
  relevantClickId: string | undefined,
): MatchQuality {
  const flags: MatchKeyFlags = {
    email: Boolean(keys.emailHash),
    phone: Boolean(keys.phoneHash),
    click_id: Boolean(relevantClickId),
    external_id: Boolean(keys.externalId),
    ip: Boolean(keys.ip),
    user_agent: Boolean(keys.userAgent),
  };
  let raw = 0;
  if (flags.email) raw += EMQ_WEIGHTS.email;
  if (flags.phone) raw += EMQ_WEIGHTS.phone;
  if (flags.click_id) raw += EMQ_WEIGHTS.clickId;
  if (flags.external_id) raw += EMQ_WEIGHTS.externalId;
  if (flags.ip) raw += EMQ_WEIGHTS.ip;
  if (flags.user_agent) raw += EMQ_WEIGHTS.userAgent;

  const count = Object.values(flags).filter(Boolean).length;
  const score = Math.min(10, Math.round(raw * 10) / 10);
  return { score, count, flags };
}

/** Há ao menos UMA match key utilizável para a plataforma? */
export function hasAnyMatchKey(
  keys: NormalizedMatchKeys,
  relevantClickId: string | undefined,
): boolean {
  return Boolean(
    keys.emailHash ||
      keys.phoneHash ||
      relevantClickId ||
      keys.externalId ||
      (keys.ip && keys.userAgent),
  );
}
