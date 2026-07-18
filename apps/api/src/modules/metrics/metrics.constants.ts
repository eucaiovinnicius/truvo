/**
 * M6 — registries e helpers de query (ClickHouse) do MetricsService.
 *
 * Regras de segurança de query:
 *  · Toda leitura filtra `workspace_id` (regra 1) + `is_bot = 0` (regra 11).
 *  · NENHUM valor do cliente é interpolado no SQL — só passa por `query_params`.
 *  · `metric` e `dimension` vêm de ENUMS validados por zod cujos valores são
 *    chaves DESTES registries (allowlist) — só então viram texto no SQL.
 */

/**
 * Colunas achatadas de `events` liberadas p/ segmentação/breakdown (allowlist).
 * Chave = nome público (usado no query string / filters); valor = coluna real.
 */
export const SEGMENT_COLUMNS = {
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  device_type: 'device_type',
  ip_country: 'ip_country',
  ip_city: 'ip_city',
  os: 'os',
  browser: 'browser',
  source: 'source',
} as const;

export type SegmentKey = keyof typeof SEGMENT_COLUMNS;
export const SEGMENT_KEYS = Object.keys(SEGMENT_COLUMNS) as SegmentKey[];

/** Dimensões válidas p/ breakdown = mesmas colunas de segmento. */
export const DIMENSION_KEYS = SEGMENT_KEYS;
export type DimensionKey = SegmentKey;

/**
 * Métricas agregáveis por bucket/dimensão (timeseries & breakdown).
 * Valor = expressão ClickHouse (constante do servidor — nunca do cliente).
 * Eventos de conversão alinhados ao 02-events.sql. `nullIf(...,0)` → null p/ razões
 * sem denominador (o front trata null como "sem dado").
 */
export const METRIC_EXPRESSIONS = {
  events: 'count()',
  revenue: 'sum(value)',
  conversions:
    "countIf(event_name IN ('purchase','checkout_completed','subscription_started'))",
  purchases: "countIf(event_name = 'purchase')",
  leads: "countIf(event_name = 'lead')",
  orders: "uniqExactIf(order_id, order_id != '')",
  visitors: 'uniqExact(anonymous_id)',
  sessions: "uniqExactIf(session_id, session_id != '')",
  aov: "sum(value) / nullIf(uniqExactIf(order_id, order_id != ''), 0)",
  cvr: "countIf(event_name = 'purchase') / nullIf(uniqExactIf(session_id, session_id != ''), 0) * 100",
} as const;

export type MetricKey = keyof typeof METRIC_EXPRESSIONS;
export const METRIC_KEYS = Object.keys(METRIC_EXPRESSIONS) as MetricKey[];

/** Granularidade → função de bucket do ClickHouse (Monday-start p/ week). */
export const GRANULARITY_BUCKET = {
  day: 'toStartOfDay(timestamp)',
  week: 'toStartOfWeek(timestamp, 1)',
  month: 'toStartOfMonth(timestamp)',
} as const;

export type Granularity = keyof typeof GRANULARITY_BUCKET;

/**
 * Campos numéricos/id liberados p/ `sum`/`unique` em fórmulas de KPI custom (allowlist).
 * Evita que o cliente aponte a agregação p/ uma coluna arbitrária.
 */
export const FORMULA_FIELDS = {
  value: 'value',
  order_id: 'order_id',
  user_id: 'user_id',
  session_id: 'session_id',
  anonymous_id: 'anonymous_id',
} as const;

export type FormulaField = keyof typeof FORMULA_FIELDS;

/** Períodos relativos suportados em filters.period → dias. */
export const RELATIVE_PERIODS: Record<string, number> = {
  today: 1,
  last_7_days: 7,
  last_14_days: 14,
  last_30_days: 30,
  last_90_days: 90,
  last_180_days: 180,
  last_365_days: 365,
};

/** Formata um instante como DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toChDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Resolve a janela [start, end) a partir de start/end ISO explícitos OU de um
 * `period` relativo, com fallback p/ os últimos `defaultDays` dias.
 */
export function resolveWindow(opts: {
  start?: string;
  end?: string;
  period?: string;
  defaultDays?: number;
}): { start: Date; end: Date } {
  const end = opts.end ? new Date(opts.end) : new Date();
  if (opts.start) {
    return { start: new Date(opts.start), end };
  }
  const days = (opts.period && RELATIVE_PERIODS[opts.period]) || opts.defaultDays || 30;
  return { start: new Date(end.getTime() - days * 24 * 3600_000), end };
}

/** Divisão segura: retorna null quando o denominador é 0/ausente (evita Infinity/NaN). */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Arredonda p/ 4 casas preservando null. */
export function round4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10000) / 10000;
}

/**
 * Constrói a cláusula de segmento (` AND col = {p:String}`) + params a partir de um
 * objeto de filtros. Só chaves da allowlist e valores não-vazios entram. Prefixa os
 * params com `pfx` p/ não colidir entre múltiplos filtros na mesma query.
 */
export function buildSegmentFilters(
  filters: Partial<Record<SegmentKey, string | undefined>> | undefined,
  pfx = 'seg',
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let clause = '';
  if (!filters) return { clause, params };
  for (const key of SEGMENT_KEYS) {
    const raw = filters[key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const p = `${pfx}_${key}`;
    clause += ` AND ${SEGMENT_COLUMNS[key]} = {${p}:String}`;
    params[p] = value;
  }
  return { clause, params };
}
