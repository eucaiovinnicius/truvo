/**
 * M16 — CATÁLOGO / VOCABULÁRIO FECHADO do compilador (código de segurança).
 *
 * Este arquivo é o allowlist que o compilador consulta. NADA que vem do cliente
 * vira SQL sem passar por aqui:
 *   · campos (top-level + context.* + properties.* validadas) → coluna física OU
 *     JSONExtract com a CHAVE amarrada como parâmetro (nunca interpolada);
 *   · measures (métricas) → expressão de agregação constante do servidor;
 *   · operadores de filtro → template fixo;
 *   · presets de data → dias.
 *
 * Os NOMES de coluna aqui são constantes do servidor (seguras p/ interpolar). Os
 * VALORES do cliente e as CHAVES de properties viram `query_params` ({nome:Tipo}).
 *
 * Regras: 1 (workspace_id), 11 (is_bot=0), 4/5 (PII nunca em claro), 19 (invariantes
 * do compilador). Ver compiler/compile.ts.
 */

// ─────────────────────────── fontes (tabelas lógicas) ───────────────────────────

export type ExplorerSource = 'events' | 'touchpoints';

export interface SourceDef {
  /** Tabela FÍSICA (constante do servidor). O modo visual roda direto nela com
   *  workspace_id injetado; o modo SQL guardado usa as views explorer.* (infra). */
  table: string;
  /** Coluna de tempo p/ janela/bucket. */
  tsColumn: string;
  /** Chave de "pessoa" p/ funnel/path/retention (expressão constante). */
  userKey: string;
}

export const SOURCES: Record<ExplorerSource, SourceDef> = {
  events: {
    table: 'events',
    tsColumn: 'timestamp',
    // user_id quando existe, senão anonymous_id (mesmo padrão do M5).
    userKey: "if(user_id != '', concat('u_', user_id), concat('a_', anonymous_id))",
  },
  touchpoints: {
    table: 'touchpoints',
    tsColumn: 'ts',
    userKey: 'canonical_id',
  },
};

// ─────────────────────────── catálogo de campos ───────────────────────────

export type FieldType = 'string' | 'number' | 'datetime';

export interface FieldDef {
  /** Coluna física achatada (constante do servidor). */
  column: string;
  type: FieldType;
  label: string;
}

/**
 * Campos fixos de `events` (top-level + context.* achatado). Chave = nome público
 * usado no spec; valor = coluna física. Alinhado ao 02-events.sql. SEM PII em claro
 * (regra 4/5): não há `email`/`ip` — só `email_hash` (ausente do explorador) e
 * `ip_country`/`ip_city`.
 */
export const EVENT_FIELDS: Record<string, FieldDef> = {
  event_name: { column: 'event_name', type: 'string', label: 'Event name' },
  source: { column: 'source', type: 'string', label: 'Source' },
  session_id: { column: 'session_id', type: 'string', label: 'Session ID' },
  user_id: { column: 'user_id', type: 'string', label: 'User ID' },
  anonymous_id: { column: 'anonymous_id', type: 'string', label: 'Anonymous ID' },
  order_id: { column: 'order_id', type: 'string', label: 'Order ID' },
  click_id: { column: 'click_id', type: 'string', label: 'Click ID' },
  value: { column: 'value', type: 'number', label: 'Value' },
  currency: { column: 'currency', type: 'string', label: 'Currency' },
  timestamp: { column: 'timestamp', type: 'datetime', label: 'Timestamp' },
  'context.utm_source': { column: 'utm_source', type: 'string', label: 'UTM source' },
  'context.utm_medium': { column: 'utm_medium', type: 'string', label: 'UTM medium' },
  'context.utm_campaign': { column: 'utm_campaign', type: 'string', label: 'UTM campaign' },
  'context.utm_content': { column: 'utm_content', type: 'string', label: 'UTM content' },
  'context.utm_term': { column: 'utm_term', type: 'string', label: 'UTM term' },
  'context.device_type': { column: 'device_type', type: 'string', label: 'Device type' },
  'context.os': { column: 'os', type: 'string', label: 'OS' },
  'context.browser': { column: 'browser', type: 'string', label: 'Browser' },
  'context.ip_country': { column: 'ip_country', type: 'string', label: 'Country' },
  'context.ip_city': { column: 'ip_city', type: 'string', label: 'City' },
  'context.page_url': { column: 'page_url', type: 'string', label: 'Page URL' },
  'context.referrer': { column: 'referrer', type: 'string', label: 'Referrer' },
};

/** Campos fixos de `touchpoints` (05-identity.sql). */
export const TOUCHPOINT_FIELDS: Record<string, FieldDef> = {
  canonical_id: { column: 'canonical_id', type: 'string', label: 'Person (canonical)' },
  channel: { column: 'channel', type: 'string', label: 'Channel' },
  order_id: { column: 'order_id', type: 'string', label: 'Order ID' },
  click_id: { column: 'click_id', type: 'string', label: 'Click ID' },
  source: { column: 'source', type: 'string', label: 'Source' },
  value: { column: 'value', type: 'number', label: 'Value' },
  ts: { column: 'ts', type: 'datetime', label: 'Timestamp' },
  'context.utm_source': { column: 'utm_source', type: 'string', label: 'UTM source' },
  'context.utm_medium': { column: 'utm_medium', type: 'string', label: 'UTM medium' },
  'context.utm_campaign': { column: 'utm_campaign', type: 'string', label: 'UTM campaign' },
};

export function fieldCatalog(source: ExplorerSource): Record<string, FieldDef> {
  return source === 'touchpoints' ? TOUCHPOINT_FIELDS : EVENT_FIELDS;
}

/** Colunas de distinção liberadas p/ `unique` (allowlist por fonte). */
export const UNIQUE_ON: Record<ExplorerSource, Record<string, string>> = {
  events: {
    user_id: 'user_id',
    session_id: 'session_id',
    anonymous_id: 'anonymous_id',
    order_id: 'order_id',
  },
  touchpoints: {
    canonical_id: 'canonical_id',
    order_id: 'order_id',
    click_id: 'click_id',
  },
};

// ─────────────────────────── properties.* (dinâmicas) ───────────────────────────

/** Prefixo que marca um campo dinâmico de `properties`. */
export const PROPERTY_PREFIX = 'properties.';

/** Chave de propriedade válida (evita nomes estranhos; a chave ainda vira PARAM). */
const PROPERTY_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Blocklist de PII (regra 4/5). Se a chave de `properties.*` casar qualquer um
 * destes fragmentos, o campo é REJEITADO — o explorador nunca reconstrói e-mail/IP/
 * documento em claro. // TODO(live): trocar por um detector de PII com amostragem
 * (regex de valor + entropia) alimentando explorer_catalog.is_pii.
 */
export const PII_BLOCKLIST = [
  'email',
  'e_mail',
  'phone',
  'telefone',
  'celular',
  'cpf',
  'cnpj',
  'rg',
  'ssn',
  'passport',
  'password',
  'senha',
  'secret',
  'token',
  'api_key',
  'apikey',
  'credit',
  'card_number',
  'cardnumber',
  'cc_number',
  'cvv',
  'iban',
  'account_number',
  'ip_address',
  'ipaddr',
  'full_name',
  'fullname',
  'birth',
  'address_line',
];

export function isPiiKey(key: string): boolean {
  const k = key.toLowerCase();
  return PII_BLOCKLIST.some((frag) => k.includes(frag));
}

export interface PropertyRef {
  kind: 'property';
  key: string;
}

/**
 * Reconhece `properties.<key>`. Retorna a chave validada (ainda sem PII) ou null se
 * não for um campo de propriedade. Lança se a chave for inválida/PII — o chamador
 * traduz para 422. Só `events` tem properties.*.
 */
export function parsePropertyField(field: string): PropertyRef | null {
  if (!field.startsWith(PROPERTY_PREFIX)) return null;
  const key = field.slice(PROPERTY_PREFIX.length);
  if (!PROPERTY_KEY_RE.test(key)) {
    throw new FieldError(`chave de propriedade inválida: '${field}'`);
  }
  if (isPiiKey(key)) {
    throw new FieldError(`campo de PII bloqueado no explorador: '${field}' (regra 4/5)`);
  }
  return { kind: 'property', key };
}

/** Erro de campo fora do catálogo / inválido → o service traduz p/ 422. */
export class FieldError extends Error {}

// ─────────────────────────── measures / operadores ───────────────────────────

export const MEASURE_METRICS = [
  'count',
  'unique',
  'sum',
  'avg',
  'min',
  'max',
  'p50',
  'p90',
  'p95',
  'rate',
] as const;
export type MeasureMetric = (typeof MEASURE_METRICS)[number];

/** Métricas que EXIGEM uma `property` numérica. */
export const METRICS_NEED_PROPERTY: ReadonlySet<MeasureMetric> = new Set<MeasureMetric>([
  'sum',
  'avg',
  'min',
  'max',
  'p50',
  'p90',
  'p95',
]);

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gte',
  'lte',
  'gt',
  'lt',
  'contains',
  'not_contains',
  'is_set',
  'is_not_set',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Operadores que comparam numericamente (usam a variante Float do campo). */
export const NUMERIC_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>(['gte', 'lte', 'gt', 'lt']);

export const GRANULARITIES = ['minute', 'hour', 'day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** Granularidade → função de bucket do ClickHouse (Monday-start p/ week). */
export function granularityBucket(gran: Granularity, tsColumn: string): string {
  switch (gran) {
    case 'minute':
      return `toStartOfMinute(${tsColumn})`;
    case 'hour':
      return `toStartOfHour(${tsColumn})`;
    case 'week':
      return `toStartOfWeek(${tsColumn}, 1)`;
    case 'month':
      return `toStartOfMonth(${tsColumn})`;
    case 'day':
    default:
      return `toStartOfDay(${tsColumn})`;
  }
}

/** Granularidade → duração do período em ms (p/ montar buckets de retenção). */
export function granularityMs(gran: Granularity): number {
  switch (gran) {
    case 'minute':
      return 60_000;
    case 'hour':
      return 3_600_000;
    case 'week':
      return 7 * 86_400_000;
    case 'month':
      return 30 * 86_400_000; // aproximação; retenção usa buckets bound como params
    case 'day':
    default:
      return 86_400_000;
  }
}

// ─────────────────────────── presets de data ───────────────────────────

/** Presets relativos → dias. Resolvidos no service (TZ do workspace — TODO(live)). */
export const DATE_PRESETS: Record<string, number> = {
  today: 1,
  yesterday: 2,
  last_7_days: 7,
  last_14_days: 14,
  last_30_days: 30,
  last_90_days: 90,
  last_180_days: 180,
  last_365_days: 365,
  this_month: 30,
  last_month: 60,
};

// ─────────────────────────── limites de execução ───────────────────────────

export interface ExecutionLimits {
  maxExecutionTime: number; // s
  maxRowsToRead: number;
  maxBytesToRead: number;
  maxMemoryUsage: number;
  maxResultRows: number;
  /** Teto do LIMIT do resultado (o spec não pode exceder). */
  hardLimit: number;
}

/** Limites padrão (produção deriva do plano via M11 — // TODO(live)). */
export const DEFAULT_LIMITS: ExecutionLimits = {
  maxExecutionTime: 20,
  maxRowsToRead: 2_000_000_000,
  maxBytesToRead: 200_000_000_000,
  maxMemoryUsage: 4_000_000_000,
  maxResultRows: 50_000,
  hardLimit: 10_000,
};

/** Limites do preview: barato e amostrado (teto agressivo, timeout curto). */
export const PREVIEW_LIMITS: ExecutionLimits = {
  maxExecutionTime: 5,
  maxRowsToRead: 200_000_000,
  maxBytesToRead: 20_000_000_000,
  maxMemoryUsage: 1_000_000_000,
  maxResultRows: 1_000,
  hardLimit: 500,
};

/** Tetos estruturais do spec (defesa contra explosão de query). */
export const SPEC_CAPS = {
  maxMeasures: 10,
  maxDimensions: 4,
  maxFunnelSteps: 12,
  maxRetentionPeriods: 12,
  maxPathSteps: 12,
  maxFilterNodes: 60,
  maxFilterDepth: 6,
  maxInValues: 200,
};
