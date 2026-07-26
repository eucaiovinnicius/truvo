import type { FunnelStep } from '@truvo/db';
import type { FunnelFiltersDto } from './dto/funnel.dto';

/**
 * Construtores de SQL do M5 (ClickHouse). Funções PURAS: recebem a config do
 * funil + filtros e devolvem `{ sql, params }`. Nunca constroem SQL com valores
 * crus do usuário — tudo que vem do payload vira `query_params` ({name:Type});
 * só inteiros JÁ validados (janela, nº de steps, limit) são interpolados.
 *
 * INVARIANTES (regras 1 e 11): TODA query filtra `workspace_id = {ws}` e
 * `is_bot = 0`. Os builders abaixo já injetam ambos — não há caminho sem eles.
 */

/**
 * Identidade da pessoa p/ o funil, AGORA resolvendo merges (regra 1 / M8): um
 * anônimo que depois se identifica deve contar como UMA pessoa no funil — senão o
 * anônimo (steps 1-2) e o identificado (step 3) viram 2 pessoas e o funil marca
 * drop-off falso. Como o grafo de identidade vive no Postgres (fora do ClickHouse),
 * resolvemos aqui de forma NATIVA no CH: derivamos `anonymous_id → user_id` dos
 * PRÓPRIOS eventos onde os dois co-ocorrem (todo evento pós-identificação carrega
 * ambos), e reescrevemos a chave. Cobre o caso principal (anon→identificado); e-mail-
 * -only/cross-device fica p/ o grafo completo. // TODO(live): quando houver um mapa de
 * canonical materializado no CH (sincronizado do M8), trocar este JOIN por ele.
 *
 * `uk` já vem computado pela subquery `eventsCanonicalSource()`; os builders só
 * agrupam por `uk`. A resolução prefere user_id do próprio evento; senão o user_id
 * resolvido do mapa; senão o anonymous_id cru.
 */
const CANONICAL_UK =
  "if(e.user_id != '', concat('u_', e.user_id), if(m.ruid != '', concat('u_', m.ruid), concat('a_', e.anonymous_id)))";

/**
 * Fonte de eventos com a coluna `uk` (identidade resolvida) já materializada por
 * linha via LEFT JOIN a um mapa anonymous_id→user_id (último user_id por anon na
 * janela). Expõe `e.*` para os builders referenciarem as colunas de evento sem
 * qualificar. Filtros base (regras 1 e 11) aplicados no alias `e`.
 */
function eventsCanonicalSource(): string {
  return `(
          SELECT e.*, ${CANONICAL_UK} AS uk
          FROM events AS e
          LEFT JOIN (
            SELECT anonymous_id, argMax(user_id, timestamp) AS ruid
            FROM events
            WHERE workspace_id = {ws:String}
              AND is_bot = 0
              AND anonymous_id != ''
              AND user_id != ''
              AND timestamp >= {start:DateTime64(3)}
              AND timestamp <  {end:DateTime64(3)}
            GROUP BY anonymous_id
          ) AS m ON e.anonymous_id = m.anonymous_id
          WHERE e.workspace_id = {ws:String}
            AND e.is_bot = 0
            AND (e.user_id != '' OR e.anonymous_id != '')
            AND e.timestamp >= {start:DateTime64(3)}
            AND e.timestamp <  {end:DateTime64(3)}
      )`;
}

/** Formata Date → DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toChDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export interface ResolvedWindow {
  start: Date;
  end: Date;
}

/** Resolve a janela [start,end). Default: últimos 30 dias (usado pelo preview). */
export function resolveWindow(startIso?: string, endIso?: string, defaultDays = 30): ResolvedWindow {
  const end = endIso ? new Date(endIso) : new Date();
  const start = startIso ? new Date(startIso) : new Date(end.getTime() - defaultDays * 86_400_000);
  return { start, end };
}

/**
 * Predicado ClickHouse de cada step (event_name + condições, combinadas por AND).
 * Retorna as expressões booleanas (uma por step) + os params correspondentes.
 */
export function buildStepPredicates(steps: FunnelStep[]): {
  exprs: string[];
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  const exprs = steps.map((step, i) => {
    const parts: string[] = [];
    const bind = (suffix: string, value: unknown): string => {
      const name = `s${i}_${suffix}`;
      params[name] = value;
      return name;
    };

    parts.push(`event_name = {${bind('evt', step.event)}:String}`);

    const c = step.conditions ?? {};
    if (c.url_contains) {
      parts.push(`positionCaseInsensitive(page_url, {${bind('url', c.url_contains)}:String}) > 0`);
    }
    if (c.element_id) {
      parts.push(`JSONExtractString(properties, 'element_id') = {${bind('eid', c.element_id)}:String}`);
    }
    if (c.property_eq) {
      const keyP = bind('pek', c.property_eq.key);
      const v = c.property_eq.value;
      if (typeof v === 'number') {
        parts.push(`JSONExtractFloat(properties, {${keyP}:String}) = {${bind('pev', v)}:Float64}`);
      } else if (typeof v === 'boolean') {
        parts.push(`JSONExtractBool(properties, {${keyP}:String}) = {${bind('pev', v ? 1 : 0)}:UInt8}`);
      } else {
        parts.push(`JSONExtractString(properties, {${keyP}:String}) = {${bind('pev', v)}:String}`);
      }
    }
    if (c.property_gte) {
      const keyP = bind('pgk', c.property_gte.key);
      parts.push(
        `JSONExtractFloat(properties, {${keyP}:String}) >= {${bind('pgv', c.property_gte.value)}:Float64}`,
      );
    }

    return `(${parts.join(' AND ')})`;
  });
  return { exprs, params };
}

/**
 * Filtros de segmento (utm/device/país). Semântica: um usuário QUALIFICA se
 * ALGUM evento dele no período casou o filtro — o funil roda sobre TODOS os
 * eventos do usuário (não perde conversões que não carregam utm). Implementado
 * via flags `max(col = valor)` na agregação por usuário + WHERE externo.
 */
export function buildFilters(filters: FunnelFiltersDto): {
  flagSelects: string[];
  outerWhere: string[];
  params: Record<string, unknown>;
} {
  const flagSelects: string[] = [];
  const outerWhere: string[] = [];
  const params: Record<string, unknown> = {};

  const addFlag = (alias: string, column: string, paramName: string, value: unknown) => {
    params[paramName] = value;
    flagSelects.push(`max(${column} = {${paramName}:String}) AS ${alias}`);
    outerWhere.push(`${alias} = 1`);
  };

  if (filters.utm_source) addFlag('has_utm_source', 'utm_source', 'f_utm_source', filters.utm_source);
  if (filters.utm_medium) addFlag('has_utm_medium', 'utm_medium', 'f_utm_medium', filters.utm_medium);
  if (filters.device_type) addFlag('has_device', 'device_type', 'f_device', filters.device_type);
  if (filters.ip_country) addFlag('has_country', 'ip_country', 'f_country', filters.ip_country);

  return { flagSelects, outerWhere, params };
}

export interface StatsSqlInput {
  workspaceId: string;
  steps: FunnelStep[];
  windowSeconds: number;
  window: ResolvedWindow;
  filters: FunnelFiltersDto;
}

/**
 * Query principal de stats: uma passada por usuário (windowFunnel + minIf por
 * step + receita), agregada no nível externo em contagens `r1..rN`, tempos
 * médios `avg_1..avg_{N-1}` e receita total.
 */
export function buildStatsSql(input: StatsSqlInput): { sql: string; params: Record<string, unknown> } {
  const { steps, windowSeconds, filters } = input;
  const n = steps.length;
  const { exprs, params: stepParams } = buildStepPredicates(steps);
  const { flagSelects, outerWhere, params: filterParams } = buildFilters(filters);

  const innerSelect = [
    'uk',
    `windowFunnel(${windowSeconds})(toDateTime(timestamp), ${exprs.join(', ')}) AS level`,
    ...exprs.map((e, i) => `minIf(timestamp, ${e}) AS t${i + 1}`),
    'sum(value) AS rev',
    ...flagSelects,
  ].join(',\n          ');

  const reachedCols = exprs.map((_, i) => `countIf(level >= ${i + 1}) AS r${i + 1}`);
  const avgCols: string[] = [];
  for (let i = 1; i < n; i++) {
    // avg tempo step i → i+1 apenas entre quem avançou e com ordem temporal válida.
    avgCols.push(
      `ifNotFinite(avgIf(dateDiff('second', t${i}, t${i + 1}), level >= ${i + 1} AND t${i + 1} >= t${i}), 0) AS avg_${i}`,
    );
  }

  const outerWhereSql = outerWhere.length ? `\n      WHERE ${outerWhere.join(' AND ')}` : '';

  const sql = `
    SELECT
      ${[...reachedCols, ...avgCols, 'ifNotFinite(sumIf(rev, level >= 1), 0) AS total_revenue'].join(',\n      ')}
    FROM (
        SELECT
          ${innerSelect}
        FROM ${eventsCanonicalSource()}
        GROUP BY uk
    )${outerWhereSql}`;

  return { sql, params: { ...stepParams, ...filterParams } };
}

/**
 * Melhor fonte de tráfego: agrupa usuários pela utm_source de primeiro toque
 * (argMin no tempo) e ranqueia por conversões (quem alcançou o último step).
 */
export function buildBestSourceSql(input: StatsSqlInput): { sql: string; params: Record<string, unknown> } {
  const { steps, windowSeconds, filters } = input;
  const n = steps.length;
  const { exprs, params: stepParams } = buildStepPredicates(steps);
  const { flagSelects, outerWhere, params: filterParams } = buildFilters(filters);

  const innerSelect = [
    'uk',
    'argMin(utm_source, timestamp) AS first_source',
    `windowFunnel(${windowSeconds})(toDateTime(timestamp), ${exprs.join(', ')}) AS level`,
    ...flagSelects,
  ].join(',\n          ');

  const outerConds = ["first_source != ''", ...outerWhere];

  const sql = `
    SELECT
      first_source AS source,
      countIf(level >= ${n}) AS conversions,
      count() AS entered
    FROM (
        SELECT
          ${innerSelect}
        FROM ${eventsCanonicalSource()}
        GROUP BY uk
    )
    WHERE ${outerConds.join(' AND ')}
    GROUP BY first_source
    ORDER BY conversions DESC, entered DESC
    LIMIT 1`;

  return { sql, params: { ...stepParams, ...filterParams } };
}

export interface DropoffSqlInput extends StatsSqlInput {
  /** 1-based; usuários com level == stepIndex (entraram no step, não avançaram). */
  stepIndex: number;
  limit: number;
}

/** Lista de usuários que pararam exatamente no step informado (level == stepIndex). */
export function buildDropoffSql(input: DropoffSqlInput): { sql: string; params: Record<string, unknown> } {
  const { steps, windowSeconds, filters, stepIndex, limit } = input;
  const { exprs, params: stepParams } = buildStepPredicates(steps);
  const { flagSelects, outerWhere, params: filterParams } = buildFilters(filters);

  const innerSelect = [
    'uk',
    `windowFunnel(${windowSeconds})(toDateTime(timestamp), ${exprs.join(', ')}) AS level`,
    'any(anonymous_id) AS anonymous_id',
    'any(user_id) AS user_id',
    'max(timestamp) AS last_event_at',
    'argMin(utm_source, timestamp) AS first_source',
    'any(device_type) AS device_type',
    'any(ip_country) AS ip_country',
    ...flagSelects,
  ].join(',\n          ');

  const outerConds = [`level = ${stepIndex}`, ...outerWhere];

  const sql = `
    SELECT uk, anonymous_id, user_id, last_event_at, first_source, device_type, ip_country
    FROM (
        SELECT
          ${innerSelect}
        FROM ${eventsCanonicalSource()}
        GROUP BY uk
    )
    WHERE ${outerConds.join(' AND ')}
    ORDER BY last_event_at DESC
    LIMIT ${limit}`;

  return { sql, params: { ...stepParams, ...filterParams } };
}

// ── Cálculo de métricas a partir das contagens brutas ────────────────────────

export interface StepMetrics {
  step_id: string;
  name: string;
  event: string;
  users_entered: number;
  users_converted: number;
  conversion_rate: number;
  drop_off_rate: number;
  avg_time_to_next_seconds: number | null;
}

export interface FunnelMetrics {
  total_visitors: number;
  steps: StepMetrics[];
  overall_conversion_rate: number;
  top_drop_off_step: { step_id: string; name: string; users_dropped: number; drop_off_rate: number } | null;
  revenue_per_visitor: number;
  total_revenue: number;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Number(((part / whole) * 100).toFixed(2));
}

/**
 * Deriva as métricas por step e do funil a partir das contagens `reached`
 * (reached[j] = usuários que alcançaram o step j+1) e dos tempos médios.
 */
export function computeFunnelMetrics(
  steps: FunnelStep[],
  reached: number[],
  avgToNext: number[],
  totalRevenue: number,
): FunnelMetrics {
  const n = steps.length;
  const entered = reached[0] ?? 0;

  const stepMetrics: StepMetrics[] = steps.map((step, j) => {
    const usersEntered = reached[j] ?? 0;
    const isLast = j === n - 1;
    const usersConverted = isLast ? usersEntered : reached[j + 1] ?? 0;
    const conversionRate = pct(usersConverted, usersEntered);
    return {
      step_id: step.step_id,
      name: step.name,
      event: step.event,
      users_entered: usersEntered,
      users_converted: usersConverted,
      conversion_rate: conversionRate,
      drop_off_rate: isLast ? 0 : Number((100 - conversionRate).toFixed(2)),
      avg_time_to_next_seconds: isLast ? null : Math.round(avgToNext[j] ?? 0),
    };
  });

  // Maior queda absoluta entre steps consecutivos (empate → mais cedo).
  let top: FunnelMetrics['top_drop_off_step'] = null;
  for (let j = 0; j < n - 1; j++) {
    const dropped = (reached[j] ?? 0) - (reached[j + 1] ?? 0);
    if (dropped > 0 && (top === null || dropped > top.users_dropped)) {
      const step = steps[j];
      if (step) {
        top = {
          step_id: step.step_id,
          name: step.name,
          users_dropped: dropped,
          drop_off_rate: pct(dropped, reached[j] ?? 0),
        };
      }
    }
  }

  return {
    total_visitors: entered,
    steps: stepMetrics,
    overall_conversion_rate: pct(reached[n - 1] ?? 0, entered),
    top_drop_off_step: top,
    revenue_per_visitor: entered > 0 ? Number((totalRevenue / entered).toFixed(4)) : 0,
    total_revenue: Number(totalRevenue.toFixed(2)),
  };
}
