/**
 * M7 — registries e helpers de query (ClickHouse) + janela do AttributionService.
 *
 * Regras de segurança de query:
 *  · Toda leitura filtra `workspace_id` (regra 1) + `is_bot = 0` (regra 11).
 *  · NENHUM valor do cliente é interpolado no SQL — só passa por `query_params`.
 *  · `model`/`window` vêm de enums validados por zod (allowlist) antes de virar
 *    qualquer coisa; o crédito é calculado em TS (attribution-models.ts).
 */

/** Modelos de atribuição (espelha @truvo/db → ATTRIBUTION_MODELS). */
export const ATTRIBUTION_MODELS = [
  'last_click',
  'first_click',
  'linear',
  'position_based',
  'time_decay',
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/** Janelas de atribuição permitidas (dias). */
export const ATTRIBUTION_WINDOWS = [1, 7, 14, 30] as const;
export type AttributionWindowDays = (typeof ATTRIBUTION_WINDOWS)[number];

/** Defaults de fábrica (quando não há linha de settings nem query param). */
export const DEFAULT_MODEL: AttributionModel = 'last_click';
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_HALF_LIFE_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * Classificação de canal (channel_resolved) — DEVE ficar em sincronia com a VIEW
 * `v_attribution_touchpoints` (08-attribution.sql). Usa `channel` quando presente,
 * senão deriva das UTMs. É um expression puro de colunas do servidor (sem valor do
 * cliente) → seguro para interpolar. O serviço seleciona isto como o rótulo de canal.
 */
export const CHANNEL_RESOLVE_SQL = `multiIf(
  channel != '',                                                  channel,
  positionCaseInsensitive(utm_medium, 'cpc')  > 0
    OR positionCaseInsensitive(utm_medium, 'ppc')  > 0
    OR positionCaseInsensitive(utm_medium, 'paid') > 0,
      multiIf(
        utm_source IN ('facebook','instagram','fb','ig','meta','tiktok',
                       'linkedin','twitter','x','pinterest','snapchat'),
            'paid_social',
        'paid_search'),
  positionCaseInsensitive(utm_medium, 'email') > 0
    OR utm_source IN ('email','newsletter'),                      'email',
  positionCaseInsensitive(utm_medium, 'social') > 0,              'organic_social',
  utm_medium = 'organic',                                         'organic',
  utm_medium = 'referral',                                        'referral',
  utm_source != '',                                              'referral',
  'direct')`;

/** Formata um instante como DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toChDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export interface ReportWindow {
  start: Date;
  end: Date;
}

/**
 * Janela de RELATÓRIO [start, end) — período em que as conversões são contadas.
 * NÃO confundir com a janela de ATRIBUIÇÃO (lookback por conversão). Default:
 * últimos `defaultDays` dias.
 */
export function resolveReportWindow(startIso?: string, endIso?: string, defaultDays = 30): ReportWindow {
  const end = endIso ? new Date(endIso) : new Date();
  const start = startIso ? new Date(startIso) : new Date(end.getTime() - defaultDays * MS_PER_DAY);
  return { start, end };
}

/**
 * `min_ts` do scan: o toque mais antigo que pode pertencer ao caminho de uma
 * conversão em [start, end) é `start - windowDays`. Buscar antes disso é desperdício;
 * depois disso perderia toques de topo de funil.
 */
export function windowFloor(start: Date, windowDays: number): Date {
  return new Date(start.getTime() - windowDays * MS_PER_DAY);
}

/** Normaliza a janela de atribuição para a allowlist (1/7/14/30). Fallback = default. */
export function coerceWindowDays(v: number | undefined, fallback = DEFAULT_WINDOW_DAYS): number {
  if (v == null) return fallback;
  return (ATTRIBUTION_WINDOWS as readonly number[]).includes(v) ? v : fallback;
}

/** Normaliza o modelo para a allowlist. Fallback = default. */
export function coerceModel(v: string | undefined, fallback: AttributionModel = DEFAULT_MODEL): AttributionModel {
  if (!v) return fallback;
  return (ATTRIBUTION_MODELS as readonly string[]).includes(v) ? (v as AttributionModel) : fallback;
}

/** Divisão segura: null quando o denominador é 0/ausente (evita Infinity/NaN). */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Arredonda p/ N casas preservando null. */
export function round(v: number | null, decimals = 2): number | null {
  if (v === null || !Number.isFinite(v)) return v === null ? null : 0;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
