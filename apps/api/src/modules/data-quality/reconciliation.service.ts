import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { dataQualitySettings, reconciliationAlerts } from '@truvo/db';
import { getClickHouse, getDb } from '../events/infra';
import { NotificationService } from '../notifications/notifications.service';
import { GatewayMetricsService } from './gateway-metrics.service';
import {
  CH_RECONCILIATION_TABLE,
  DEFAULT_RECONCILIATION_GAP_THRESHOLD,
  REFUND_EVENT,
  REVENUE_EVENTS,
} from './constants';
import {
  computeGap,
  dayToChDateTime,
  addDays,
  eachDay,
  money,
  resolveRange,
  toNum,
} from './util';

type DayStatus = 'reconciled' | 'uncertain' | 'no_ground_truth';

export interface ReconciliationDay {
  day: string;
  truvo_revenue: number;
  truvo_orders: number;
  gateway_revenue: number;
  gateway_orders: number;
  /** |truvo-gateway|/gateway, ou null quando não há ground truth. */
  gap: number | null;
  status: DayStatus;
}

export interface ReconciliationSummary {
  threshold: number;
  has_ground_truth: boolean;
  period_truvo_revenue: number;
  period_gateway_revenue: number;
  period_truvo_orders: number;
  period_gateway_orders: number;
  /** Gap do PERÍODO inteiro (agregado), não a média dos gaps diários. */
  period_gap: number | null;
  worst_day_gap: number | null;
  days_uncertain: number;
  /** Rótulo de confiança do período — o que M15/M16/M17 leem (regra 12). */
  reconciliation: DayStatus;
  trusted: boolean;
}

export interface ReconciliationResult {
  range: { start: string; end: string };
  summary: ReconciliationSummary;
  days: ReconciliationDay[];
}

interface TruvoDaily {
  day: string;
  revenue: number;
  orders: number;
}

/**
 * M14 — Serviço de reconciliação. Por dia/workspace: soma receita/pedidos do TRUVO
 * (ClickHouse, `is_bot = 0` — regra 11) e compara com o total REAL do gateway
 * (Postgres/webhook_logs, via GatewayMetricsService). Calcula
 * `reconciliation_gap = |truvo-gateway|/gateway`, persiste em `reconciliation_daily`
 * (ClickHouse) e, quando o gap estoura o limiar, registra alerta (regra 12) para o
 * M12 consumir.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly gateway: GatewayMetricsService,
    private readonly notifications: NotificationService,
  ) {}

  /** GET /v1/data-quality/reconciliation — recomputa (ao vivo), persiste e devolve. */
  async getReconciliation(
    workspaceId: string,
    start: string | undefined,
    end: string | undefined,
  ): Promise<ReconciliationResult> {
    return this.reconcileRange(workspaceId, start, end, { persist: true });
  }

  /**
   * Núcleo: reconcilia [start, end] dia a dia. `persist` grava em
   * `reconciliation_daily` (só dias com atividade) e gera alertas.
   */
  async reconcileRange(
    workspaceId: string,
    start: string | undefined,
    end: string | undefined,
    opts: { persist: boolean },
  ): Promise<ReconciliationResult> {
    const { startDay, endDay } = resolveRange(start, end);
    const threshold = await this.resolveThreshold(workspaceId);

    const [truvoByDay, gatewayRows] = await Promise.all([
      this.truvoDaily(workspaceId, startDay, endDay),
      this.gateway.dailyTotals(workspaceId, startDay, endDay),
    ]);

    const truvoMap = new Map(truvoByDay.map((r) => [r.day, r]));
    const gatewayMap = new Map(gatewayRows.map((r) => [r.day, r]));

    const days: ReconciliationDay[] = eachDay(startDay, endDay).map((day) => {
      const t = truvoMap.get(day);
      const g = gatewayMap.get(day);
      const truvoRevenue = money(t?.revenue ?? 0);
      const gatewayRevenue = money(g?.revenue ?? 0);
      const gap = computeGap(truvoRevenue, gatewayRevenue);
      const status: DayStatus =
        gap === null ? 'no_ground_truth' : gap > threshold ? 'uncertain' : 'reconciled';
      return {
        day,
        truvo_revenue: truvoRevenue,
        truvo_orders: t?.orders ?? 0,
        gateway_revenue: gatewayRevenue,
        gateway_orders: g?.orders ?? 0,
        gap: gap === null ? null : round4(gap),
        status,
      };
    });

    const summary = this.summarize(days, threshold);

    if (opts.persist) {
      const active = days.filter(
        (d) => d.truvo_revenue > 0 || d.gateway_revenue > 0 || d.truvo_orders > 0 || d.gateway_orders > 0,
      );
      await this.persist(workspaceId, active, threshold);
      await this.raiseAlerts(workspaceId, active, threshold);
    }

    return { range: { start: startDay, end: endDay }, summary, days };
  }

  /* ─────────────────────────── Truvo (ClickHouse) ─────────────────────────── */

  private async truvoDaily(
    workspaceId: string,
    startDay: string,
    endDay: string,
  ): Promise<TruvoDaily[]> {
    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          toDate(timestamp)                                                     AS day,
          sumIf(value, event_name IN {revenue_events:Array(String)})
            - sumIf(value, event_name = {refund_event:String})                  AS revenue,
          uniqExactIf(order_id, event_name IN {revenue_events:Array(String)} AND order_id != '') AS orders
        FROM events
        WHERE workspace_id = {workspace_id:String}
          AND is_bot = 0                                                        -- regra 11
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
        GROUP BY day
        ORDER BY day`,
      query_params: {
        workspace_id: workspaceId,
        revenue_events: [...REVENUE_EVENTS],
        refund_event: REFUND_EVENT,
        start: dayToChDateTime(startDay),
        end: dayToChDateTime(addDays(endDay, 1)), // fim exclusivo = endDay + 1 dia
      },
      format: 'JSONEachRow',
    });
    const rows = (await rs.json()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      day: String(r['day']),
      revenue: toNum(r['revenue']),
      orders: Math.trunc(toNum(r['orders'])), // UInt64 chega como string no JSON
    }));
  }

  /* ─────────────────────────── persistência (CH) ─────────────────────────── */

  private async persist(
    workspaceId: string,
    days: ReconciliationDay[],
    threshold: number,
  ): Promise<void> {
    if (days.length === 0) return;
    const ch = getClickHouse();
    try {
      await ch.insert({
        table: CH_RECONCILIATION_TABLE,
        values: days.map((d) => ({
          workspace_id: workspaceId,
          day: d.day,
          truvo_revenue: d.truvo_revenue,
          truvo_orders: d.truvo_orders,
          gateway_revenue: d.gateway_revenue,
          gateway_orders: d.gateway_orders,
          reconciliation_gap: d.gap ?? 0,
          status: d.status,
          threshold,
        })),
        format: 'JSONEachRow',
      });
    } catch (err) {
      // Persistir é best-effort: a resposta ao cliente não depende disso. Loga.
      this.logger.warn(
        `falha ao persistir reconciliation_daily (workspace=${workspaceId}): ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    }
  }

  /* ─────────────────────────── alertas (Postgres) ─────────────────────────── */

  private async raiseAlerts(
    workspaceId: string,
    days: ReconciliationDay[],
    threshold: number,
  ): Promise<void> {
    const breaches = days.filter((d) => d.status === 'uncertain' && d.gap !== null);
    if (breaches.length === 0) return;
    if (!(await this.alertsEnabled(workspaceId))) return;

    const db = getDb();
    for (const d of breaches) {
      try {
        await db
          .insert(reconciliationAlerts)
          .values({
            id: `dqa_${ulid()}`,
            workspaceId,
            day: d.day,
            gap: d.gap ?? 0,
            threshold,
            truvoRevenue: d.truvo_revenue,
            gatewayRevenue: d.gateway_revenue,
            status: 'open',
          })
          .onConflictDoUpdate({
            target: [reconciliationAlerts.workspaceId, reconciliationAlerts.day],
            set: {
              gap: d.gap ?? 0,
              threshold,
              truvoRevenue: d.truvo_revenue,
              gatewayRevenue: d.gateway_revenue,
              // reabre se o gap voltou a estourar depois de resolvido.
              status: 'open',
              updatedAt: new Date(),
            },
          });
      } catch (err) {
        this.logger.warn(
          `falha ao registrar reconciliation_alert (workspace=${workspaceId}, day=${d.day}): ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
      }

      // Entrega pelo M12 (NotificationService): dedup por dia + regra/preferências.
      await this.notifications.dispatch(workspaceId, 'quality.reconciliation_gap', {
        data: {
          gap: d.gap,
          threshold,
          day: d.day,
          truvo_revenue: d.truvo_revenue,
          gateway_revenue: d.gateway_revenue,
        },
        dedupId: d.day,
      });
    }
  }

  /* ─────────────────────────────── settings ─────────────────────────────── */

  private async resolveThreshold(workspaceId: string): Promise<number> {
    const envDefault = toNum(
      process.env.RECONCILIATION_GAP_THRESHOLD,
      DEFAULT_RECONCILIATION_GAP_THRESHOLD,
    );
    try {
      const db = getDb();
      const rows = await db
        .select({ threshold: dataQualitySettings.reconciliationGapThreshold })
        .from(dataQualitySettings)
        .where(eq(dataQualitySettings.workspaceId, workspaceId))
        .limit(1);
      const row = rows[0];
      if (row && Number.isFinite(row.threshold) && row.threshold > 0) return row.threshold;
    } catch {
      // settings ainda não migrado → usa default do env.
    }
    return envDefault > 0 ? envDefault : DEFAULT_RECONCILIATION_GAP_THRESHOLD;
  }

  private async alertsEnabled(workspaceId: string): Promise<boolean> {
    try {
      const db = getDb();
      const rows = await db
        .select({ enabled: dataQualitySettings.alertsEnabled })
        .from(dataQualitySettings)
        .where(eq(dataQualitySettings.workspaceId, workspaceId))
        .limit(1);
      const row = rows[0];
      return row ? row.enabled : true; // default: alertas ligados.
    } catch {
      return true;
    }
  }

  /* ─────────────────────────────── summary ─────────────────────────────── */

  private summarize(days: ReconciliationDay[], threshold: number): ReconciliationSummary {
    let truvo = 0;
    let gateway = 0;
    let truvoOrders = 0;
    let gatewayOrders = 0;
    let daysUncertain = 0;
    let worst: number | null = null;

    for (const d of days) {
      truvo += d.truvo_revenue;
      gateway += d.gateway_revenue;
      truvoOrders += d.truvo_orders;
      gatewayOrders += d.gateway_orders;
      if (d.status === 'uncertain') daysUncertain += 1;
      if (d.gap !== null) worst = worst === null ? d.gap : Math.max(worst, d.gap);
    }

    truvo = money(truvo);
    gateway = money(gateway);
    const hasGroundTruth = gateway > 0;
    const periodGap = computeGap(truvo, gateway);
    const periodGapRounded = periodGap === null ? null : round4(periodGap);

    const reconciliation: DayStatus = !hasGroundTruth
      ? 'no_ground_truth'
      : periodGap !== null && periodGap > threshold
        ? 'uncertain'
        : 'reconciled';

    return {
      threshold,
      has_ground_truth: hasGroundTruth,
      period_truvo_revenue: truvo,
      period_gateway_revenue: gateway,
      period_truvo_orders: truvoOrders,
      period_gateway_orders: gatewayOrders,
      period_gap: periodGapRounded,
      worst_day_gap: worst === null ? null : round4(worst),
      days_uncertain: daysUncertain,
      reconciliation,
      trusted: reconciliation === 'reconciled',
    };
  }
}

/** Arredonda uma razão para 4 casas (gaps pequenos precisam de precisão). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
