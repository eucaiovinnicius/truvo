import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { webhookLogs } from '@truvo/db';
import { getDb } from '../events/infra';
import { REFUND_EVENT, REVENUE_EVENTS } from './constants';
import { addDays, toNum } from './util';

/** Receita/pedidos reais do gateway por dia (`YYYY-MM-DD`). */
export interface GatewayDaily {
  day: string;
  revenue: number;
  orders: number;
}

/**
 * GROUND TRUTH da receita = o GATEWAY (Shopify/Stripe/Hotmart/Kiwify), lido dos
 * `webhook_logs` do M4 (regra: "primeiro reconciliar com o gateway", PRD §10).
 *
 * Cada webhook `processed` guardou em `payload_summary` um resumo sem PII
 * (`event_name`, `order_id`, `value`, `currency`). Somamos aqui a receita líquida
 * (compras menos estornos) e contamos pedidos distintos por dia.
 *
 * Se o workspace não tem integração de gateway configurada, não há linhas
 * `processed` → retorno vazio → o serviço de reconciliação marca 'no_ground_truth'
 * (não inventamos número — regra 12).
 */
@Injectable()
export class GatewayMetricsService {
  private readonly logger = new Logger(GatewayMetricsService.name);

  /**
   * Agrega o gateway por dia no intervalo [startDay, endDay] (ambos inclusivos).
   * Agregação feita no Postgres (jsonb) para não puxar linha a linha.
   */
  async dailyTotals(
    workspaceId: string,
    startDay: string,
    endDay: string,
  ): Promise<GatewayDaily[]> {
    const db = getDb();
    // Fim EXCLUSIVO = dia seguinte a endDay, 00:00 UTC.
    const startAt = new Date(`${startDay}T00:00:00.000Z`);
    const endAtExclusive = new Date(`${addDays(endDay, 1)}T00:00:00.000Z`);

    // Lista literal e segura (constantes internas — sem input do cliente).
    const revenueList = sql.join(
      REVENUE_EVENTS.map((e) => sql`${e}`),
      sql`, `,
    );

    // event_name / value / order_id vivem em payload_summary (jsonb).
    const eventName = sql`(${webhookLogs.payloadSummary} ->> 'event_name')`;
    const value = sql`coalesce((${webhookLogs.payloadSummary} ->> 'value')::numeric, 0)`;
    const orderId = sql`(${webhookLogs.payloadSummary} ->> 'order_id')`;

    try {
      const rows = await db
        .select({
          day: sql<string>`to_char((${webhookLogs.receivedAt} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`,
          // receita líquida: compras somam, estornos subtraem.
          revenue: sql<string>`coalesce(sum(
            case
              when ${eventName} = ${REFUND_EVENT} then -1 * ${value}
              when ${eventName} in (${revenueList}) then ${value}
              else 0
            end
          ), 0)`,
          // pedidos distintos apenas dos eventos de receita.
          orders: sql<string>`count(distinct case when ${eventName} in (${revenueList}) then ${orderId} end)`,
        })
        .from(webhookLogs)
        .where(
          and(
            eq(webhookLogs.workspaceId, workspaceId),
            eq(webhookLogs.status, 'processed'),
            gte(webhookLogs.receivedAt, startAt),
            lt(webhookLogs.receivedAt, endAtExclusive),
          ),
        )
        .groupBy(sql`1`);

      return rows.map((r) => ({
        day: String(r.day),
        revenue: toNum(r.revenue),
        orders: Math.trunc(toNum(r.orders)),
      }));
    } catch (err) {
      // Sem webhook_logs (M4 não migrado) ou erro de query → sem ground truth.
      // Não derruba a reconciliação; loga e devolve vazio.
      this.logger.warn(
        `gateway ground truth indisponível p/ workspace=${workspaceId}: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      // TODO(live): distinguir "sem integração" de "erro de infra" e alertar (M12).
      return [];
    }
  }
}
