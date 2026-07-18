import type { TimelineQueryDto } from './dto/profiles.dto';

/**
 * Construtores de SQL do M15 (ClickHouse). Funções PURAS: recebem os
 * identificadores da pessoa (já resolvidos no Postgres — M8) + filtros e devolvem
 * `{ sql, params }`. NENHUM valor do cliente é interpolado no SQL — tudo vira
 * `query_params` ({name:Type}); só inteiros JÁ validados (limit) são interpolados.
 *
 * INVARIANTES (regras 1 e 11): TODA query filtra `workspace_id = {ws:String}` e
 * `is_bot = 0`. Regra 5: a timeline devolve as colunas de contexto ACHATADAS
 * (IP-free) — o IP bruto não existe em `events` e nunca é montado.
 */

/** Formata Date → DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toChDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** Formata Date → 'YYYY-MM-DD' (partição/dia do ClickHouse). */
export function toChDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Converte um DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC) em ISO 8601.
 * Retorna null para o "zero" do ClickHouse (min/max sobre conjunto vazio) ou vazio.
 */
export function chTimestampToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.startsWith('1970-01-01 00:00:00')) return null; // default de agregação sobre vazio
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Deriva um canal grosseiro a partir de utm_medium/utm_source (fallback: direct).
 * Mesma heurística do M8 (identity.service) — mantida em sincronia.
 */
export function deriveChannel(utmSource: string | undefined, utmMedium: string | undefined): string {
  const medium = (utmMedium ?? '').toLowerCase();
  if (medium === 'cpc' || medium === 'ppc' || medium === 'paid' || medium === 'paidsearch') return 'paid_search';
  if (medium === 'social' || medium === 'paid_social' || medium === 'paidsocial') return 'paid_social';
  if (medium === 'email') return 'email';
  if (medium === 'organic') return 'organic';
  if (medium === 'referral') return 'referral';
  if (utmSource) return 'referral';
  return 'direct';
}

// ───────────────────────────── cursor (timeline) ─────────────────────────────

/** Cursor opaco da timeline: (timestamp, event_id) da última linha da página. */
export interface TimelineCursor {
  /** timestamp do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm'). */
  t: string;
  /** event_id. */
  id: string;
}

/** Serializa o cursor em base64url (opaco para o cliente). */
export function encodeCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Desserializa o cursor; retorna null se malformado (tratado como "sem cursor"). */
export function decodeCursor(raw: string | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as TimelineCursor).t === 'string' &&
      typeof (parsed as TimelineCursor).id === 'string'
    ) {
      return { t: (parsed as TimelineCursor).t, id: (parsed as TimelineCursor).id };
    }
  } catch {
    // cursor inválido → ignora (começa do topo).
  }
  return null;
}

// ───────────────────────── filtro de "pessoa" (M8) ─────────────────────────

/** Identificadores estáveis da pessoa (resolvidos em identity_links, M8). */
export interface ActorIdentifiers {
  userIds: string[];
  anonymousIds: string[];
}

/**
 * Predicado ClickHouse que casa QUALQUER evento da pessoa: `user_id` em um dos
 * user_ids OU `anonymous_id` em um dos anonymous_ids costurados. Ambos como
 * `Array(String)` param (nunca interpolados).
 */
function actorPredicate(params: Record<string, unknown>, actor: ActorIdentifiers): string {
  params.actor_uids = actor.userIds;
  params.actor_anons = actor.anonymousIds;
  return "((user_id != '' AND user_id IN {actor_uids:Array(String)}) OR (anonymous_id != '' AND anonymous_id IN {actor_anons:Array(String)}))";
}

// ───────────────────────────────── timeline ─────────────────────────────────

/** Colunas retornadas pela timeline (todas IP-free — regra 5). */
export interface TimelineRow {
  event_id: string;
  event_name: string;
  source: string;
  /** DateTime64 do ClickHouse como String ('YYYY-MM-DD HH:MM:SS.mmm'). */
  event_ts: string;
  anonymous_id: string;
  user_id: string;
  session_id: string;
  order_id: string;
  value: number | string;
  currency: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  page_url: string;
  referrer: string;
  ip_country: string;
  ip_city: string;
  device_type: string;
  os: string;
  browser: string;
  properties: string;
}

export interface TimelineSqlInput {
  workspaceId: string;
  actor: ActorIdentifiers;
  filters: Pick<TimelineQueryDto, 'start' | 'end' | 'event_name' | 'source' | 'device_type'>;
  cursor: TimelineCursor | null;
  /** já validado (1..200); pedimos limit+1 para saber se há próxima página. */
  limit: number;
}

/**
 * Timeline de eventos de UMA pessoa (ordem DESC), com filtros e paginação por
 * cursor `(timestamp, event_id)`. Lê a `events` raw (história completa; regras 1 e 11).
 */
export function buildTimelineSql(input: TimelineSqlInput): { sql: string; params: Record<string, unknown> } {
  const { workspaceId, actor, filters, cursor, limit } = input;
  const params: Record<string, unknown> = { ws: workspaceId };

  const where: string[] = ['workspace_id = {ws:String}', 'is_bot = 0', actorPredicate(params, actor)];

  if (filters.start) {
    params.start = toChDateTime(new Date(filters.start));
    where.push('timestamp >= {start:DateTime64(3)}');
  }
  if (filters.end) {
    params.end = toChDateTime(new Date(filters.end));
    where.push('timestamp <= {end:DateTime64(3)}');
  }
  if (filters.event_name) {
    params.f_event = filters.event_name;
    where.push('event_name = {f_event:String}');
  }
  if (filters.source) {
    params.f_source = filters.source;
    where.push('source = {f_source:String}');
  }
  if (filters.device_type) {
    params.f_device = filters.device_type;
    where.push('device_type = {f_device:String}');
  }
  if (cursor) {
    params.cur_ts = cursor.t;
    params.cur_id = cursor.id;
    // DESC → próxima página é "mais antiga": timestamp menor, desempate por event_id.
    where.push(
      '(timestamp < {cur_ts:DateTime64(3)} OR (timestamp = {cur_ts:DateTime64(3)} AND event_id < {cur_id:String}))',
    );
  }

  const sql = `
    SELECT
      event_id, event_name, source, toString(timestamp) AS event_ts,
      anonymous_id, user_id, session_id, order_id, value, currency,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      page_url, referrer, ip_country, ip_city, device_type, os, browser,
      properties
    FROM events
    WHERE ${where.join('\n      AND ')}
    ORDER BY timestamp DESC, event_id DESC
    LIMIT ${limit}`;

  return { sql, params };
}

// ───────────────────────── métricas (recompute da projeção) ─────────────────────────

/** Linha agregada do recompute de métricas de uma pessoa. */
export interface MetricsRow {
  ltv: number | string;
  orders_count: number | string;
  sessions_count: number | string;
  events_count: number | string;
  first_ts: string | null;
  last_ts: string | null;
  currency: string;
  ft_utm_source: string;
  ft_utm_medium: string;
  ft_utm_campaign: string;
  lt_utm_source: string;
  lt_utm_medium: string;
  lt_utm_campaign: string;
}

/**
 * Agrega LTV/orders/sessions/events + primeiro/último toque (argMin/argMax por
 * timestamp) da pessoa, is_bot = 0. Base do recompute da projeção `user_profiles`.
 */
export function buildMetricsSql(
  workspaceId: string,
  actor: ActorIdentifiers,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { ws: workspaceId };
  const actorWhere = actorPredicate(params, actor);
  const sql = `
    SELECT
      sum(value)                                   AS ltv,
      uniqExactIf(order_id, order_id != '')        AS orders_count,
      uniqExactIf(session_id, session_id != '')    AS sessions_count,
      count()                                      AS events_count,
      toString(min(timestamp))                     AS first_ts,
      toString(max(timestamp))                     AS last_ts,
      anyIf(currency, currency != '')              AS currency,
      argMin(utm_source, timestamp)                AS ft_utm_source,
      argMin(utm_medium, timestamp)                AS ft_utm_medium,
      argMin(utm_campaign, timestamp)              AS ft_utm_campaign,
      argMax(utm_source, timestamp)                AS lt_utm_source,
      argMax(utm_medium, timestamp)                AS lt_utm_medium,
      argMax(utm_campaign, timestamp)              AS lt_utm_campaign
    FROM events
    WHERE workspace_id = {ws:String}
      AND is_bot = 0
      AND ${actorWhere}`;
  return { sql, params };
}

/** Linha de device costurado. */
export interface DeviceRow {
  device_type: string;
  os: string;
  browser: string;
  first_seen: string;
}

/** Devices distintos da pessoa (device_type+os+browser), ordenados por 1ª aparição. */
export function buildDevicesSql(
  workspaceId: string,
  actor: ActorIdentifiers,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { ws: workspaceId };
  const actorWhere = actorPredicate(params, actor);
  const sql = `
    SELECT
      device_type, os, browser, toString(min(timestamp)) AS first_seen
    FROM events
    WHERE workspace_id = {ws:String}
      AND is_bot = 0
      AND ${actorWhere}
      AND (device_type != '' OR os != '' OR browser != '')
    GROUP BY device_type, os, browser
    ORDER BY first_seen ASC
    LIMIT 50`;
  return { sql, params };
}

// ───────────────────────────────── jornada ─────────────────────────────────

/** Linha de touchpoint (M7/M8) da jornada da pessoa. */
export interface TouchpointRow {
  ts: string;
  channel: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  click_id: string;
  order_id: string;
  source: string;
  value: number | string;
}

/**
 * Touchpoints da pessoa (canonical_id) em ordem cronológica ASC — matéria-prima da
 * jornada de conversão do M7. Filtra workspace + is_bot = 0 (regras 1 e 11).
 */
export function buildJourneySql(
  workspaceId: string,
  canonicalId: string,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { ws: workspaceId, cid: canonicalId };
  const sql = `
    SELECT
      toString(ts) AS ts, channel, utm_source, utm_medium, utm_campaign,
      click_id, order_id, source, value
    FROM touchpoints
    WHERE workspace_id = {ws:String}
      AND canonical_id = {cid:String}
      AND is_bot = 0
    ORDER BY ts ASC
    LIMIT 5000`;
  return { sql, params };
}

// ─────────────────────── incerteza (reconciliation — M14) ───────────────────────

/** Pior gap de reconciliação no período de atividade da pessoa (regra 12). */
export interface ReconGapRow {
  gap: number | string | null;
  threshold: number | string | null;
  has_ground_truth: number | string | null;
}

/**
 * Lê `reconciliation_daily` (M14) no intervalo [startDay, endDay] e devolve o PIOR
 * gap do período (marca de incerteza). FINAL colapsa versões do ReplacingMergeTree.
 */
export function buildReconGapSql(
  workspaceId: string,
  startDay: Date,
  endDay: Date,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    ws: workspaceId,
    start_day: toChDate(startDay),
    end_day: toChDate(endDay),
  };
  const sql = `
    SELECT
      max(reconciliation_gap)              AS gap,
      max(threshold)                       AS threshold,
      maxIf(1, gateway_revenue > 0)        AS has_ground_truth
    FROM reconciliation_daily FINAL
    WHERE workspace_id = {ws:String}
      AND day >= {start_day:Date}
      AND day <= {end_day:Date}`;
  return { sql, params };
}
