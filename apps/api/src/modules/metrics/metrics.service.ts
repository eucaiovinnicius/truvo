import { BadRequestException, Injectable } from '@nestjs/common';
import type { KpiFormula, KpiTerm } from '@truvo/db';
import { getClickHouse } from './infra';
import {
  buildSegmentFilters,
  FORMULA_FIELDS,
  GRANULARITY_BUCKET,
  METRIC_EXPRESSIONS,
  resolveWindow,
  round4,
  safeDiv,
  toChDateTime,
  type FormulaField,
  type Granularity,
  type MetricKey,
  type SegmentKey,
} from './metrics.constants';

/** Janela + segmento resolvidos, comuns a toda leitura. */
export interface MetricScope {
  start?: string;
  end?: string;
  period?: string;
  /** filtros de segmento (utm_*, device_type, ip_*, os, browser, source). */
  segment?: Partial<Record<SegmentKey, string | undefined>>;
}

interface RawKpiRow {
  revenue: number | string;
  orders: number | string;
  purchases: number | string;
  conversions: number | string;
  purchasers: number | string;
  sessions: number | string;
  visitors: number | string;
  leads: number | string;
  subscription_value: number | string;
  events: number | string;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

@Injectable()
export class MetricsService {
  // ───────────────────────── KPIs nativos ─────────────────────────

  /**
   * KPIs nativos (PRD §7 M6) para uma janela + segmento. Um único scan agrega os
   * contadores base; os KPIs derivados são calculados em JS com divisão segura.
   *
   * `ad_spend` vem do M10 (Ads) — não existe na tabela `events`. Enquanto o M10
   * não alimenta uma fonte de spend, os KPIs dependentes (ROAS/CAC/CPL) retornam
   * null e `spend_available=false`. // TODO(live): ler spend agregado do M10.
   */
  async nativeKpis(workspaceId: string, scope: MetricScope) {
    const { start, end } = resolveWindow({ ...scope, defaultDays: 30 });
    const seg = buildSegmentFilters(scope.segment);

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          sum(value)                                                   AS revenue,
          uniqExactIf(order_id, order_id != '')                        AS orders,
          countIf(event_name = 'purchase')                             AS purchases,
          countIf(event_name IN ('purchase','checkout_completed','subscription_started')) AS conversions,
          uniqExactIf(user_id, event_name IN ('purchase','checkout_completed','subscription_started') AND user_id != '') AS purchasers,
          uniqExactIf(session_id, session_id != '')                    AS sessions,
          uniqExact(anonymous_id)                                      AS visitors,
          countIf(event_name = 'lead')                                 AS leads,
          sumIf(value, event_name = 'subscription_started')            AS subscription_value,
          count()                                                      AS events
        FROM events
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
          ${seg.clause}`,
      query_params: {
        ws: workspaceId,
        start: toChDateTime(start),
        end: toChDateTime(end),
        ...seg.params,
      },
      format: 'JSONEachRow',
    });

    const rows = await rs.json<RawKpiRow>();
    const r = rows[0];
    const revenue = num(r?.revenue);
    const orders = num(r?.orders);
    const purchases = num(r?.purchases);
    const conversions = num(r?.conversions);
    const purchasers = num(r?.purchasers);
    const sessions = num(r?.sessions);
    const visitors = num(r?.visitors);
    const leads = num(r?.leads);
    const subscriptionValue = num(r?.subscription_value);

    // ad_spend indisponível até o M10 alimentar uma fonte de spend.
    const adSpend = 0;
    const spendAvailable = false;

    const aov = safeDiv(revenue, orders);
    const avgOrdersPerUser = safeDiv(orders, purchasers);
    const ltv =
      aov !== null && avgOrdersPerUser !== null ? aov * avgOrdersPerUser : safeDiv(revenue, purchasers);
    const cvrRatio = safeDiv(purchases, sessions);

    return {
      window: { start: start.toISOString(), end: end.toISOString() },
      spend_available: spendAvailable,
      totals: {
        revenue: round4(revenue),
        ad_spend: adSpend,
        orders,
        purchases,
        conversions,
        purchasers,
        sessions,
        visitors,
        leads,
      },
      kpis: {
        roas: spendAvailable ? round4(safeDiv(revenue, adSpend)) : null,
        cac: spendAvailable ? round4(safeDiv(adSpend, purchasers)) : null,
        cpl: spendAvailable ? round4(safeDiv(adSpend, leads)) : null,
        ltv: round4(ltv),
        aov: round4(aov),
        cvr: round4(cvrRatio === null ? null : cvrRatio * 100),
        mrr: round4(subscriptionValue),
      },
    };
  }

  // ───────────────────────── Timeseries ─────────────────────────

  /** Série temporal de uma métrica agregável por bucket (day/week/month). */
  async timeseries(
    workspaceId: string,
    metric: MetricKey,
    granularity: Granularity,
    scope: MetricScope,
  ) {
    const expr = METRIC_EXPRESSIONS[metric];
    const bucket = GRANULARITY_BUCKET[granularity];
    if (!expr || !bucket) {
      // Defesa extra: metric/granularity já vêm de enums zod (allowlist).
      throw new BadRequestException('métrica ou granularidade inválida');
    }
    const { start, end } = resolveWindow({ ...scope, defaultDays: 30 });
    const seg = buildSegmentFilters(scope.segment);

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          toString(${bucket}) AS bucket,
          ${expr}             AS value
        FROM events
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
          ${seg.clause}
        GROUP BY bucket
        ORDER BY bucket`,
      query_params: {
        ws: workspaceId,
        start: toChDateTime(start),
        end: toChDateTime(end),
        ...seg.params,
      },
      format: 'JSONEachRow',
    });

    const rows = await rs.json<{ bucket: string; value: number | string | null }>();
    return {
      metric,
      granularity,
      window: { start: start.toISOString(), end: end.toISOString() },
      series: rows.map((row) => ({
        bucket: row.bucket,
        value: row.value === null ? null : round4(num(row.value)),
      })),
    };
  }

  // ───────────────────────── Breakdown ─────────────────────────

  /** Breakdown de uma métrica por dimensão (top N por valor desc). */
  async breakdown(
    workspaceId: string,
    metric: MetricKey,
    dimension: SegmentKey,
    limit: number,
    scope: MetricScope,
  ) {
    const expr = METRIC_EXPRESSIONS[metric];
    // dimension é chave de SEGMENT_COLUMNS (mesma allowlist) — reusa o mapa.
    const seg = buildSegmentFilters(scope.segment);
    const { start, end } = resolveWindow({ ...scope, defaultDays: 30 });
    const dimCol = dimension; // já validado por enum; nome == coluna achatada.

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          ${dimCol} AS dimension,
          ${expr}   AS value
        FROM events
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
          ${seg.clause}
        GROUP BY dimension
        ORDER BY value DESC
        LIMIT {lim:UInt32}`,
      query_params: {
        ws: workspaceId,
        start: toChDateTime(start),
        end: toChDateTime(end),
        lim: limit,
        ...seg.params,
      },
      format: 'JSONEachRow',
    });

    const rows = await rs.json<{ dimension: string; value: number | string | null }>();
    return {
      metric,
      dimension,
      window: { start: start.toISOString(), end: end.toISOString() },
      rows: rows.map((row) => ({
        dimension: row.dimension === '' || row.dimension == null ? '(none)' : row.dimension,
        value: row.value === null ? null : round4(num(row.value)),
      })),
    };
  }

  // ───────────────────── KPI customizado (fórmula) ─────────────────────

  /**
   * Avalia uma fórmula visual: (numerator / denominator) × multiplier, no ClickHouse.
   * Sem SQL do cliente — cada termo vira countIf/sumIf/uniqExactIf com allowlist de
   * campo. `event` filtra event_name (use '*' p/ todos).
   */
  async evaluateFormula(workspaceId: string, formula: KpiFormula, scope: MetricScope) {
    const { start, end } = resolveWindow({ ...scope, defaultDays: 30 });
    const seg = buildSegmentFilters(scope.segment);

    const params: Record<string, string | number> = {
      ws: workspaceId,
      start: toChDateTime(start),
      end: toChDateTime(end),
      ...seg.params,
    };

    const numExpr = this.termExpr(formula.numerator, 'num', params);
    const hasDen = !!formula.denominator;
    const denExpr = hasDen ? this.termExpr(formula.denominator as KpiTerm, 'den', params) : '0';

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          ${numExpr} AS numerator,
          ${denExpr} AS denominator
        FROM events
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
          ${seg.clause}`,
      query_params: params,
      format: 'JSONEachRow',
    });

    const rows = await rs.json<{ numerator: number | string; denominator: number | string }>();
    const numerator = num(rows[0]?.numerator);
    const denominator = num(rows[0]?.denominator);
    const multiplier = typeof formula.multiplier === 'number' ? formula.multiplier : 1;

    let value: number | null;
    if (hasDen) {
      const ratio = safeDiv(numerator, denominator);
      value = ratio === null ? null : ratio * multiplier;
    } else {
      value = numerator * multiplier;
    }

    return {
      window: { start: start.toISOString(), end: end.toISOString() },
      numerator: round4(numerator),
      denominator: hasDen ? round4(denominator) : null,
      multiplier,
      value: round4(value),
    };
  }

  /**
   * Monta a expressão de agregação de um termo, registrando os params necessários.
   * `pfx` isola os params de numerador/denominador. `event` (event_name) e `field`
   * (allowlist) nunca são interpolados como valor — só como {param}/coluna validada.
   */
  private termExpr(term: KpiTerm, pfx: string, params: Record<string, string | number>): string {
    const eventCond =
      term.event === '*'
        ? '1'
        : (() => {
            params[`ev_${pfx}`] = term.event;
            return `event_name = {ev_${pfx}:String}`;
          })();

    if (term.aggregation === 'count') {
      return `countIf(${eventCond})`;
    }

    // sum | unique exigem field da allowlist.
    const fieldKey = term.field as FormulaField | undefined;
    const col = fieldKey ? FORMULA_FIELDS[fieldKey] : undefined;
    if (!fieldKey || !col) {
      throw new BadRequestException(`campo inválido para agregação '${term.aggregation}'`);
    }

    // `value` é a única coluna numérica; as demais são String (ids).
    const isNumericField = fieldKey === 'value';

    if (term.aggregation === 'sum') {
      // Somar uma coluna String quebraria no ClickHouse — só numérica.
      if (!isNumericField) {
        throw new BadRequestException("agregação 'sum' só é válida no campo 'value'");
      }
      return `sumIf(${col}, ${eventCond})`;
    }

    // unique: guarda de não-vazio só p/ colunas String (comparar Float64 a '' quebraria).
    const nonEmpty = isNumericField ? '' : ` AND ${col} != ''`;
    return `uniqExactIf(${col}, (${eventCond})${nonEmpty})`;
  }
}
