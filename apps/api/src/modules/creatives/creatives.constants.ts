/**
 * M10 — CREATIVE ANALYTICS · constantes e helpers puros.
 *
 * Regras de query (ClickHouse):
 *  · Todo read do lado REAL sai de `creative_real_daily` (MV que já filtra
 *    is_bot = 0 — regra 11) e SEMPRE filtra workspace_id (regra 1).
 *  · `creative_daily` é dado REPORTADO pela plataforma (sem conceito de bot).
 *  · NENHUM valor do cliente é interpolado no SQL — só via `query_params`.
 *    `platform`/`order_by`/`type`/`phase` passam por allowlist (zod) antes.
 */

import type { CreativePlatform } from '@truvo/db';

/** Nomes das tabelas ClickHouse do M10 (ddl/09-creatives.sql). */
export const CH_CREATIVE_DAILY = 'creative_daily';
export const CH_CREATIVE_REAL_DAILY = 'creative_real_daily';

/** Plataformas suportadas (espelha @truvo/db → CREATIVE_PLATFORMS). */
export const CREATIVE_PLATFORMS = ['meta', 'google', 'tiktok'] as const;

/** Fases (topo/meio/fundo de funil de mídia). */
export const CREATIVE_PHASES = ['TOF', 'MOF', 'BOF'] as const;

/** Tipos de criativo (formato do anúncio). */
export const CREATIVE_TYPES = ['image', 'video', 'carousel'] as const;

/**
 * Campos de ordenação do grid (allowlist). Ordenamos em TS (após juntar os dois
 * lados) — nunca vira coluna crua no SQL.
 */
export const CREATIVE_ORDER_BY = [
  'roas_real',
  'revenue_real',
  'conversions_real',
  'spend',
  'delta_roas',
  'delta_percent',
  'ctr',
  'roas_reported',
  'impressions',
  'clicks',
] as const;
export type CreativeOrderBy = (typeof CREATIVE_ORDER_BY)[number];

/** Eventos que contam como receita/conversão (alinhado a M14/@truvo/event-schema). */
export const REVENUE_EVENTS = ['purchase', 'checkout_completed', 'subscription_started'] as const;
export const REFUND_EVENT = 'refund';

/** Fontes de anúncio conhecidas por plataforma (para o provider de discrepância). */
export const PLATFORM_TO_SOURCE: Record<CreativePlatform, string> = {
  meta: 'facebook',
  google: 'google',
  tiktok: 'tiktok',
};

/**
 * Canal de atribuição (M7) por plataforma. Meta/TikTok → paid_social; Google →
 * paid_search. Alinha o AdSpendProvider com o `channel_resolved` do M7.
 */
export const PLATFORM_TO_CHANNEL: Record<CreativePlatform, string> = {
  meta: 'paid_social',
  google: 'paid_search',
  tiktok: 'paid_social',
};

/** Lê um número do ENV com fallback (config de limiar de alerta). */
function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Limiares dos alertas automáticos (PRD §7 M10). Configuráveis por ENV; os
 * defaults são os do PRD. Ver .env.example (bloco M10).
 */
export const ALERT_THRESHOLDS = {
  /** Fadiga: ROAS real caiu mais que isto (fração) na janela vs. a anterior. */
  fatigueRoasDropPct: envNum('CREATIVE_FATIGUE_ROAS_DROP', 0.3),
  /** Discrepância: |delta_percent| acima disto (fração) → verificar tracking. */
  discrepancyDeltaPct: envNum('CREATIVE_DISCREPANCY_DELTA', 0.5),
  /** Top performer: ROAS real acima disto por N dias → aumentar budget. */
  topRoas: envNum('CREATIVE_TOP_ROAS', 5),
  topSustainedDays: envNum('CREATIVE_TOP_DAYS', 7),
  /** Gasto sem conversão: spend acima disto com 0 conversões reais → pausar. */
  spendNoConversion: envNum('CREATIVE_SPEND_NO_CONVERSION', 500),
  /** Amostra mínima de spend p/ fadiga fazer sentido (evita ruído de valores baixos). */
  fatigueMinSpend: envNum('CREATIVE_FATIGUE_MIN_SPEND', 50),
} as const;

// ───────────────────────────── helpers numéricos ─────────────────────────────

/** Coerção segura para número (string/number/null → number). */
export function asNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Coerção segura para string. */
export function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Divisão segura: null quando o denominador é 0/ausente (evita Infinity/NaN). */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Arredonda para N casas preservando null. */
export function round(v: number | null, decimals = 2): number | null {
  if (v === null) return null;
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Arredonda dinheiro (2 casas). */
export function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

// ───────────────────────────── helpers de data ─────────────────────────────

const DEFAULT_RANGE_DAYS = 30;

/** Normaliza `YYYY-MM-DD` ou ISO para um dia UTC `YYYY-MM-DD`. null se inválida. */
export function toDayUtc(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Dia UTC de hoje (`YYYY-MM-DD`). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Adiciona `days` (pode ser negativo) a um dia `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface DayRange {
  startDay: string;
  endDay: string;
}

/**
 * Resolve a janela [startDay, endDay] (ambos inclusivos). Default: últimos
 * {@link DEFAULT_RANGE_DAYS} dias até hoje. Garante start <= end.
 */
export function resolveDayRange(
  startInput: string | undefined,
  endInput: string | undefined,
  defaultDays = DEFAULT_RANGE_DAYS,
): DayRange {
  const endDay = toDayUtc(endInput) ?? todayUtc();
  const startDay = toDayUtc(startInput) ?? addDays(endDay, -(defaultDays - 1));
  if (startDay > endDay) return { startDay: endDay, endDay: startDay };
  return { startDay, endDay };
}

/** Nº de dias inclusivos entre dois dias `YYYY-MM-DD`. */
export function dayCount(startDay: string, endDay: string): number {
  const a = new Date(`${startDay}T00:00:00.000Z`).getTime();
  const b = new Date(`${endDay}T00:00:00.000Z`).getTime();
  return Math.floor((b - a) / 86_400_000) + 1;
}
