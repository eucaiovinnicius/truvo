import type { ExplorerFilterCondition, ExplorerFilterNode, InsightType } from '@truvo/db';
import { ParamBag } from './param-bag';
import type { ExplorerQuerySpecInput } from './spec';
import {
  fieldCatalog,
  FieldError,
  granularityBucket,
  granularityMs,
  METRICS_NEED_PROPERTY,
  NUMERIC_OPS,
  parsePropertyField,
  SOURCES,
  SPEC_CAPS,
  UNIQUE_ON,
  type ExecutionLimits,
  type ExplorerSource,
  type FieldDef,
  type FilterOp,
  type Granularity,
  type MeasureMetric,
} from './catalog';

/**
 * M16 — COMPILADOR (código de segurança). Transforma um `ExplorerQuerySpec` já
 * validado de forma (spec.ts) em SQL ClickHouse PARAMETRIZADO.
 *
 * INVARIANTES INEGOCIÁVEIS (regra 19), sempre no WHERE, fora do controle do cliente:
 *   · workspace_id = {ws:String}   — vem da sessão/guard, NUNCA do body;
 *   · is_bot = 0                    — regra 11 (bots não contam);
 *   · janela de data (>= start, < end).
 *
 * Todo valor do cliente vira `query_params` ({nome:Tipo}) via ParamBag — NUNCA
 * interpolação de string. Só constantes do servidor (nomes de coluna do catálogo,
 * limites numéricos, nº de steps/períodos já validados) são interpoladas.
 *
 * Qualquer campo/measure/operador fora do vocabulário fechado → FieldError (422).
 */

// Eventos que representam receita/conversão (p/ marca de incerteza — regra 12).
const REVENUE_EVENTS = new Set([
  'purchase',
  'checkout_completed',
  'subscription_started',
  'refund',
]);

export interface CompileContext {
  workspaceId: string;
  start: Date;
  end: Date;
  limits: ExecutionLimits;
}

export interface CompileMeta {
  insightType: InsightType;
  source: ExplorerSource;
  /** true se a query toca receita/conversão → resposta carrega marca de incerteza. */
  touchesRevenue: boolean;
  measures: Array<{ id: string; alias: string }>;
  dimensions: Array<{ field: string; alias: string }>;
  hasTimeBucket: boolean;
  granularity?: Granularity;
  retentionPeriods?: Array<{ index: number; from: string; to: string }>;
  funnelSteps?: string[];
  limit: number;
}

export interface CompiledQuery {
  sql: string;
  params: Record<string, unknown>;
  meta: CompileMeta;
}

/** Formata Date → DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toChDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// ─────────────────────────── resolução de campos ───────────────────────────

type ResolvedField =
  | { kind: 'column'; column: string; type: FieldDef['type'] }
  | { kind: 'property'; key: string };

/** Resolve um campo do spec contra o catálogo da fonte (allowlist). Lança FieldError. */
function resolveField(source: ExplorerSource, field: string): ResolvedField {
  const catalog = fieldCatalog(source);
  const def = catalog[field];
  if (def) return { kind: 'column', column: def.column, type: def.type };

  // properties.* só existe na fonte `events` (touchpoints não tem coluna properties).
  const prop = parsePropertyField(field); // lança em PII/chave inválida
  if (prop) {
    if (source !== 'events') {
      throw new FieldError(`properties.* indisponível na fonte '${source}': '${field}'`);
    }
    return { kind: 'property', key: prop.key };
  }
  throw new FieldError(`campo fora do catálogo: '${field}'`);
}

/** Expressão String de um campo (p/ dimensão / eq / in / contains). */
function fieldAsString(rf: ResolvedField, pb: ParamBag): string {
  if (rf.kind === 'property') {
    return `JSONExtractString(properties, ${pb.bind(rf.key, 'String')})`;
  }
  if (rf.type === 'string') return rf.column;
  return `toString(${rf.column})`;
}

/** Expressão numérica de um campo (p/ gte/lte/gt/lt e property de measure). */
function fieldAsNumber(rf: ResolvedField, pb: ParamBag): string {
  if (rf.kind === 'property') {
    return `JSONExtractFloat(properties, ${pb.bind(rf.key, 'String')})`;
  }
  if (rf.type === 'number') return rf.column;
  throw new FieldError('comparação numérica exige campo numérico ou properties.*');
}

/** Existência de um campo (is_set / is_not_set). */
function fieldExists(rf: ResolvedField, pb: ParamBag, present: boolean): string {
  if (rf.kind === 'property') {
    const has = `JSONHas(properties, ${pb.bind(rf.key, 'String')})`;
    return present ? has : `NOT ${has}`;
  }
  if (rf.type === 'string') return present ? `${rf.column} != ''` : `${rf.column} = ''`;
  // Colunas numéricas/datetime têm default; tratamos como sempre presentes.
  return present ? '1' : '0';
}

// ─────────────────────────── filtros ───────────────────────────

function isGroup(node: ExplorerFilterNode): node is { op: 'and' | 'or'; conditions: ExplorerFilterNode[] } {
  return (node as { conditions?: unknown }).conditions !== undefined;
}

/** Compila a árvore de filtros → cláusula booleana + params. Aplica teto de profundidade. */
function compileFilters(
  node: ExplorerFilterNode | undefined,
  source: ExplorerSource,
  pb: ParamBag,
  depth = 0,
): string {
  if (!node) return '';
  if (depth > SPEC_CAPS.maxFilterDepth) {
    throw new FieldError('árvore de filtros profunda demais');
  }
  if (isGroup(node)) {
    const parts = node.conditions
      .map((c) => compileFilters(c, source, pb, depth + 1))
      .filter((p) => p.length > 0);
    if (parts.length === 0) return '';
    const joiner = node.op === 'or' ? ' OR ' : ' AND ';
    return `(${parts.join(joiner)})`;
  }
  return compileCondition(node, source, pb);
}

function normalizeArray(value: ExplorerFilterCondition['value']): string[] {
  if (!Array.isArray(value)) throw new FieldError("operador 'in/not_in' exige um array");
  return value.map((v) => String(v));
}

function compileCondition(cond: ExplorerFilterCondition, source: ExplorerSource, pb: ParamBag): string {
  const rf = resolveField(source, cond.field);
  const op = cond.op as FilterOp;

  if (op === 'is_set') return fieldExists(rf, pb, true);
  if (op === 'is_not_set') return fieldExists(rf, pb, false);

  if (op === 'in' || op === 'not_in') {
    const arr = normalizeArray(cond.value);
    const s = fieldAsString(rf, pb);
    const ph = pb.bind(arr, 'Array(String)');
    return op === 'in' ? `${s} IN (${ph})` : `${s} NOT IN (${ph})`;
  }

  if (cond.value === undefined || cond.value === null || Array.isArray(cond.value)) {
    throw new FieldError(`operador '${op}' exige um valor escalar`);
  }

  if (op === 'contains' || op === 'not_contains') {
    const s = fieldAsString(rf, pb);
    const ph = pb.bind(String(cond.value), 'String');
    return op === 'contains'
      ? `positionCaseInsensitive(${s}, ${ph}) > 0`
      : `positionCaseInsensitive(${s}, ${ph}) = 0`;
  }

  if (NUMERIC_OPS.has(op)) {
    const n = fieldAsNumber(rf, pb);
    const ph = pb.bind(Number(cond.value), 'Float64');
    const sym = op === 'gte' ? '>=' : op === 'lte' ? '<=' : op === 'gt' ? '>' : '<';
    return `${n} ${sym} ${ph}`;
  }

  // eq / neq — numérico se a coluna é numérica, senão string.
  const numeric = rf.kind === 'column' && rf.type === 'number';
  if (numeric) {
    const n = fieldAsNumber(rf, pb);
    const ph = pb.bind(Number(cond.value), 'Float64');
    return op === 'eq' ? `${n} = ${ph}` : `${n} != ${ph}`;
  }
  const s = fieldAsString(rf, pb);
  const ph = pb.bind(String(cond.value), 'String');
  return op === 'eq' ? `${s} = ${ph}` : `${s} != ${ph}`;
}

// ─────────────────────────── measures ───────────────────────────

/**
 * Shape permissivo de measure (o metric vem do zod como `string`; validamos contra
 * o vocabulário fechado no ponto de uso). Estruturalmente = ExplorerMeasure.
 */
interface SpecMeasure {
  id: string;
  metric: string;
  event?: string;
  property?: string;
  on?: string;
}

/** Condição de evento de uma measure (event_name = {p} | '1'). */
function eventCond(event: string | undefined, pb: ParamBag): string {
  if (!event || event === '*') return '1';
  return `event_name = ${pb.bind(event, 'String')}`;
}

function measureNumberExpr(m: SpecMeasure, source: ExplorerSource, pb: ParamBag): string {
  if (!m.property) {
    throw new FieldError(`metric '${m.metric}' exige 'property' numérica`);
  }
  const rf = resolveField(source, m.property);
  return fieldAsNumber(rf, pb);
}

const PERCENTILES: Partial<Record<MeasureMetric, number>> = { p50: 0.5, p90: 0.9, p95: 0.95 };

function compileMeasureExpr(m: SpecMeasure, source: ExplorerSource, pb: ParamBag): string {
  const metric = m.metric as MeasureMetric;
  const cond = eventCond(m.event, pb);

  switch (metric) {
    case 'count':
      return `countIf(${cond})`;
    case 'rate':
      return `countIf(${cond}) / nullIf(count(), 0)`;
    case 'unique': {
      const onKey = m.on ?? '';
      const onCol = UNIQUE_ON[source][onKey];
      if (!onCol) {
        throw new FieldError(`metric 'unique' exige 'on' válido para a fonte '${source}'`);
      }
      // Colunas de distinção são String → guarda de não-vazio.
      return `uniqExactIf(${onCol}, (${cond}) AND ${onCol} != '')`;
    }
    case 'sum':
      return `sumIf(${measureNumberExpr(m, source, pb)}, ${cond})`;
    case 'avg':
      return `avgIf(${measureNumberExpr(m, source, pb)}, ${cond})`;
    case 'min':
      return `minIf(${measureNumberExpr(m, source, pb)}, ${cond})`;
    case 'max':
      return `maxIf(${measureNumberExpr(m, source, pb)}, ${cond})`;
    case 'p50':
    case 'p90':
    case 'p95': {
      const q = PERCENTILES[metric] ?? 0.5;
      return `quantileIf(${q})(${measureNumberExpr(m, source, pb)}, ${cond})`;
    }
    default:
      // Inalcançável: metric vem de enum validado.
      throw new FieldError(`metric desconhecida: '${String(metric)}'`);
  }
}

// ─────────────────────────── invariantes / settings ───────────────────────────

function invariantsWhere(source: ExplorerSource, filterClause: string): string {
  const tsCol = SOURCES[source].tsColumn;
  const parts = [
    'workspace_id = {ws:String}', // regra 1/19 — SEMPRE, da sessão
    'is_bot = 0', // regra 11
    `${tsCol} >= {start:DateTime64(3)}`,
    `${tsCol} < {end:DateTime64(3)}`,
  ];
  if (filterClause) parts.push(`(${filterClause})`);
  return parts.join('\n    AND ');
}

function settingsBlock(limits: ExecutionLimits): string {
  // Todos os valores são constantes do servidor. result/timeout overflow = 'throw'
  // p/ NUNCA devolver resultado parcial disfarçado de completo (regra 12 / abort).
  return [
    `SETTINGS max_execution_time = ${limits.maxExecutionTime}`,
    `max_rows_to_read = ${limits.maxRowsToRead}`,
    `max_bytes_to_read = ${limits.maxBytesToRead}`,
    `max_memory_usage = ${limits.maxMemoryUsage}`,
    `max_result_rows = ${limits.maxResultRows}`,
    `result_overflow_mode = 'throw'`,
    `timeout_overflow_mode = 'throw'`,
  ].join(',\n         ');
}

/** LIMIT efetivo = min(spec.limit, teto do plano). */
function resolveLimit(specLimit: number | undefined, limits: ExecutionLimits): number {
  const requested = typeof specLimit === 'number' && specLimit > 0 ? specLimit : limits.hardLimit;
  return Math.max(1, Math.min(requested, limits.hardLimit));
}

// ─────────────────────────── dimensões ───────────────────────────

interface CompiledDims {
  selects: string[]; // `${expr} AS d{i}`
  groupRefs: string[]; // `d{i}`
  aliasByField: Map<string, string>;
  meta: Array<{ field: string; alias: string }>;
}

function compileDimensions(
  spec: ExplorerQuerySpecInput,
  source: ExplorerSource,
  pb: ParamBag,
): CompiledDims {
  const dims: string[] = [];
  const seen = new Set<string>();
  for (const f of [...(spec.dimensions ?? []), ...(spec.group_by ?? [])]) {
    if (!seen.has(f)) {
      seen.add(f);
      dims.push(f);
    }
  }
  if (dims.length > SPEC_CAPS.maxDimensions) {
    throw new FieldError(`máximo de ${SPEC_CAPS.maxDimensions} dimensões`);
  }
  const selects: string[] = [];
  const groupRefs: string[] = [];
  const aliasByField = new Map<string, string>();
  const meta: Array<{ field: string; alias: string }> = [];
  dims.forEach((field, i) => {
    const rf = resolveField(source, field);
    const alias = `d${i}`;
    selects.push(`${fieldAsString(rf, pb)} AS ${alias}`);
    groupRefs.push(alias);
    aliasByField.set(field, alias);
    meta.push({ field, alias });
  });
  return { selects, groupRefs, aliasByField, meta };
}

// ─────────────────────────── ORDER BY ───────────────────────────

function compileOrder(
  spec: ExplorerQuerySpecInput,
  measureAliasById: Map<string, string>,
  dimAliasByField: Map<string, string>,
  hasBucket: boolean,
  defaultClause: string,
): string {
  const order = spec.order ?? [];
  if (order.length === 0) return defaultClause;
  const parts = order.map((o) => {
    const alias =
      measureAliasById.get(o.by) ??
      dimAliasByField.get(o.by) ??
      (o.by === 'bucket' && hasBucket ? 'bucket' : undefined);
    if (!alias) throw new FieldError(`order.by desconhecido: '${o.by}'`);
    return `${alias} ${o.dir === 'asc' ? 'ASC' : 'DESC'}`;
  });
  return `ORDER BY ${parts.join(', ')}`;
}

// ─────────────────────────── measures → meta ───────────────────────────

interface CompiledMeasures {
  selects: string[]; // `${expr} AS m{i}`
  aliasById: Map<string, string>;
  meta: Array<{ id: string; alias: string }>;
  touchesRevenue: boolean;
}

function compileMeasures(
  measures: SpecMeasure[],
  source: ExplorerSource,
  pb: ParamBag,
): CompiledMeasures {
  const selects: string[] = [];
  const aliasById = new Map<string, string>();
  const meta: Array<{ id: string; alias: string }> = [];
  let touchesRevenue = false;

  measures.forEach((m, i) => {
    if (aliasById.has(m.id)) throw new FieldError(`measure.id duplicado: '${m.id}'`);
    if (METRICS_NEED_PROPERTY.has(m.metric as MeasureMetric) && !m.property) {
      throw new FieldError(`metric '${m.metric}' exige 'property'`);
    }
    const alias = `m${i}`;
    selects.push(`${compileMeasureExpr(m, source, pb)} AS ${alias}`);
    aliasById.set(m.id, alias);
    meta.push({ id: m.id, alias });
    if (source === 'events') {
      if (m.property && (m.property === 'value' || m.property === 'context.value')) touchesRevenue = true;
      if (m.event && REVENUE_EVENTS.has(m.event)) touchesRevenue = true;
    }
  });
  return { selects, aliasById, meta, touchesRevenue };
}

// ─────────────────────────── compiladores por tipo ───────────────────────────

function compileAggregate(
  spec: Extract<ExplorerQuerySpecInput, { insight_type: 'trends' | 'breakdown' }>,
  source: ExplorerSource,
  ctx: CompileContext,
  pb: ParamBag,
  withTimeBucket: boolean,
): CompiledQuery {
  const tsCol = SOURCES[source].tsColumn;
  const filterClause = compileFilters(spec.filters, source, pb);
  const dims = compileDimensions(spec, source, pb);
  const meas = compileMeasures(spec.measures, source, pb);

  const selectParts: string[] = [];
  const groupParts: string[] = [];
  const gran = (spec.granularity as Granularity | undefined) ?? 'day';
  if (withTimeBucket) {
    selectParts.push(`toString(${granularityBucket(gran, tsCol)}) AS bucket`);
    groupParts.push('bucket');
  }
  selectParts.push(...dims.selects);
  groupParts.push(...dims.groupRefs);
  selectParts.push(...meas.selects);

  const firstMeasureAlias = meas.meta[0]?.alias ?? 'm0';
  const defaultOrder = withTimeBucket ? 'ORDER BY bucket' : `ORDER BY ${firstMeasureAlias} DESC`;
  const orderClause = compileOrder(spec, meas.aliasById, dims.aliasByField, withTimeBucket, defaultOrder);

  const limit = resolveLimit(spec.limit, ctx.limits);
  const groupClause = groupParts.length ? `GROUP BY ${groupParts.join(', ')}` : '';

  const sql = `SELECT
    ${selectParts.join(',\n    ')}
  FROM ${SOURCES[source].table}
  WHERE ${invariantsWhere(source, filterClause)}
  ${groupClause}
  ${orderClause}
  LIMIT ${limit}
  ${settingsBlock(ctx.limits)}`;

  return {
    sql,
    params: pb.params,
    meta: {
      insightType: spec.insight_type,
      source,
      touchesRevenue: meas.touchesRevenue,
      measures: meas.meta,
      dimensions: dims.meta,
      hasTimeBucket: withTimeBucket,
      granularity: withTimeBucket ? gran : undefined,
      limit,
    },
  };
}

function compileFunnel(
  spec: Extract<ExplorerQuerySpecInput, { insight_type: 'funnel' }>,
  source: ExplorerSource,
  ctx: CompileContext,
  pb: ParamBag,
): CompiledQuery {
  const tsCol = SOURCES[source].tsColumn;
  const userKey = SOURCES[source].userKey;
  const baseFilter = compileFilters(spec.filters, source, pb);

  const windowDays = typeof spec.window_days === 'number' ? spec.window_days : 7;
  const windowSeconds = Math.max(1, Math.min(windowDays, 90)) * 86_400;

  const stepExprs: string[] = [];
  const stepLabels: string[] = [];
  let touchesRevenue = false;
  spec.steps.forEach((step) => {
    const parts = [`event_name = ${pb.bind(step.event, 'String')}`];
    const sf = compileFilters(step.filters, source, pb);
    if (sf) parts.push(sf);
    stepExprs.push(`(${parts.join(' AND ')})`);
    stepLabels.push(step.event);
    if (REVENUE_EVENTS.has(step.event)) touchesRevenue = true;
  });

  const reached = stepExprs.map((_, i) => `countIf(level >= ${i + 1}) AS s${i + 1}`);

  const sql = `SELECT
    ${reached.join(',\n    ')}
  FROM (
    SELECT
      ${userKey} AS uk,
      windowFunnel(${windowSeconds})(${tsCol}, ${stepExprs.join(', ')}) AS level
    FROM ${SOURCES[source].table}
    WHERE ${invariantsWhere(source, baseFilter)}
    GROUP BY uk
  )
  ${settingsBlock(ctx.limits)}`;

  return {
    sql,
    params: pb.params,
    meta: {
      insightType: 'funnel',
      source,
      touchesRevenue,
      measures: [],
      dimensions: [],
      hasTimeBucket: false,
      funnelSteps: stepLabels,
      limit: spec.steps.length,
    },
  };
}

function compileRetention(
  spec: Extract<ExplorerQuerySpecInput, { insight_type: 'retention' }>,
  source: ExplorerSource,
  ctx: CompileContext,
  pb: ParamBag,
): CompiledQuery {
  const tsCol = SOURCES[source].tsColumn;
  const userKey = SOURCES[source].userKey;
  const filterClause = compileFilters(spec.filters, source, pb);
  const gran = (spec.granularity as Granularity | undefined) ?? 'day';
  const step = granularityMs(gran);

  const rangeMs = Math.max(step, ctx.end.getTime() - ctx.start.getTime());
  const maxByRange = Math.max(2, Math.floor(rangeMs / step));
  const requested = spec.retention.periods ?? maxByRange;
  const periods = Math.max(2, Math.min(requested, maxByRange, SPEC_CAPS.maxRetentionPeriods));

  const ie = pb.bind(spec.retention.initial_event, 'String');
  const re = pb.bind(spec.retention.return_event, 'String');

  const conds: string[] = [];
  const periodMeta: Array<{ index: number; from: string; to: string }> = [];
  for (let i = 0; i < periods; i++) {
    const from = new Date(ctx.start.getTime() + i * step);
    const to = i === periods - 1 ? ctx.end : new Date(ctx.start.getTime() + (i + 1) * step);
    const fromPh = pb.bindNamed(`r${i}s`, toChDateTime(from), 'DateTime64(3)');
    const toPh = pb.bindNamed(`r${i}e`, toChDateTime(to), 'DateTime64(3)');
    const evPh = i === 0 ? ie : re;
    conds.push(`event_name = ${evPh} AND ${tsCol} >= ${fromPh} AND ${tsCol} < ${toPh}`);
    periodMeta.push({ index: i, from: from.toISOString(), to: to.toISOString() });
  }

  const outerSelects = periodMeta.map((p) => `sum(r[${p.index + 1}]) AS period_${p.index}`);

  const sql = `SELECT
    ${outerSelects.join(',\n    ')}
  FROM (
    SELECT
      ${userKey} AS uk,
      retention(
        ${conds.map((c) => `(${c})`).join(',\n        ')}
      ) AS r
    FROM ${SOURCES[source].table}
    WHERE ${invariantsWhere(source, filterClause)}
    GROUP BY uk
  )
  ${settingsBlock(ctx.limits)}`;

  return {
    sql,
    params: pb.params,
    meta: {
      insightType: 'retention',
      source,
      touchesRevenue: false,
      measures: [],
      dimensions: [],
      hasTimeBucket: false,
      granularity: gran,
      retentionPeriods: periodMeta,
      limit: periods,
    },
  };
}

function compilePath(
  spec: Extract<ExplorerQuerySpecInput, { insight_type: 'path' }>,
  source: ExplorerSource,
  ctx: CompileContext,
  pb: ParamBag,
): CompiledQuery {
  const tsCol = SOURCES[source].tsColumn;
  const userKey = SOURCES[source].userKey;
  const filterClause = compileFilters(spec.filters, source, pb);

  const maxSteps = Math.max(2, Math.min(spec.path?.max_steps ?? 8, SPEC_CAPS.maxPathSteps));
  const limit = resolveLimit(spec.limit, ctx.limits);

  let startFilter = '';
  if (spec.path?.start_event) {
    const se = pb.bind(spec.path.start_event, 'String');
    // O caminho deve começar pelo evento inicial (sozinho ou seguido de ' > ').
    startFilter = `WHERE (path = ${se} OR startsWith(path, concat(${se}, ' > ')))`;
  }

  const sql = `SELECT
    path,
    count() AS users
  FROM (
    SELECT
      uk,
      arrayStringConcat(
        arrayMap(t -> t.2, arraySlice(arraySort(groupArray((ev_ts, en))), 1, ${maxSteps})),
        ' > '
      ) AS path
    FROM (
      SELECT
        ${userKey} AS uk,
        ${tsCol} AS ev_ts,
        event_name AS en
      FROM ${SOURCES[source].table}
      WHERE ${invariantsWhere(source, filterClause)}
    )
    GROUP BY uk
  )
  ${startFilter}
  GROUP BY path
  ORDER BY users DESC
  LIMIT ${limit}
  ${settingsBlock(ctx.limits)}`;

  return {
    sql,
    params: pb.params,
    meta: {
      insightType: 'path',
      source,
      touchesRevenue: false,
      measures: [],
      dimensions: [],
      hasTimeBucket: false,
      limit,
    },
  };
}

// ─────────────────────────── entrypoint ───────────────────────────

/**
 * Compila o spec → { sql, params, meta }. `ctx.workspaceId` (da sessão) e a janela
 * [start,end) são vinculados como params RESERVADOS (ws/start/end) ANTES de qualquer
 * valor do cliente — são invariantes, não campos do spec (regra 19).
 */
export function compileSpec(spec: ExplorerQuerySpecInput, ctx: CompileContext): CompiledQuery {
  const source = (spec.source ?? 'events') as ExplorerSource;
  const pb = new ParamBag();

  // Invariantes vinculadas primeiro (nomes fixos; o cliente não os controla).
  pb.bindNamed('ws', ctx.workspaceId, 'String');
  pb.bindNamed('start', toChDateTime(ctx.start), 'DateTime64(3)');
  pb.bindNamed('end', toChDateTime(ctx.end), 'DateTime64(3)');

  switch (spec.insight_type) {
    case 'trends':
      return compileAggregate(spec, source, ctx, pb, true);
    case 'breakdown':
      return compileAggregate(spec, source, ctx, pb, false);
    case 'funnel':
      return compileFunnel(spec, source, ctx, pb);
    case 'retention':
      return compileRetention(spec, source, ctx, pb);
    case 'path':
      return compilePath(spec, source, ctx, pb);
    default:
      // Inalcançável: insight_type vem de união discriminada validada.
      throw new FieldError('insight_type não suportado');
  }
}
