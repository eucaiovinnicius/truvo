import { Inject, Injectable } from '@nestjs/common';
import { getClickHouse } from '../events/infra';
import { REFUND_EVENT, REVENUE_EVENTS } from './constants';
import {
  PLATFORM_METRICS_PROVIDER,
  type PlatformDailyMetric,
  type PlatformMetricsProvider,
} from './platform-metrics';
import { addDays, dayToChDateTime, money, resolveRange, toNum } from './util';

interface TruvoChannelDay {
  day: string;
  channel: string;
  conversions: number;
  revenue: number;
}

export interface DiscrepancyRow {
  day: string;
  channel: string;
  truvo_conversions: number;
  truvo_revenue: number;
  /** null enquanto o M10 (plataforma) não estiver disponível. */
  platform_conversions: number | null;
  platform_revenue: number | null;
  /** truvo_conversions - platform_conversions (null se plataforma indisponível). */
  delta_conversions: number | null;
  /** Delta muito acima do histórico costuma indicar problema de tracking. */
  spike: boolean;
}

export interface DiscrepancyReport {
  range: { start: string; end: string };
  ad_account: string | null;
  platform_available: boolean;
  /** Aviso honesto quando não há lado-plataforma para comparar (regra 12/PRD §M14). */
  notice?: string;
  rows: DiscrepancyRow[];
}

/**
 * M14 — Monitor de discrepância PLATAFORMA vs TRUVO (PRD §M14).
 *
 * Acompanha, por conta de anúncio/canal ao longo do tempo, a diferença entre o
 * que a plataforma reporta (M10) e as conversões RECONCILIADAS do Truvo. Um delta
 * que dispara de repente normalmente é PROBLEMA DE TRACKING, não superioridade —
 * então marcamos `spike` e alertamos, em vez de comemorar.
 *
 * O lado Truvo é calculado aqui (ClickHouse, `is_bot = 0`). O lado plataforma vem
 * do {@link PlatformMetricsProvider} (M10, onda futura). Sem M10, o provider é o
 * stub indisponível: reportamos só o Truvo e sinalizamos `platform_available:false`
 * — nunca inventamos o número da plataforma.
 */
@Injectable()
export class DiscrepancyService {
  constructor(
    @Inject(PLATFORM_METRICS_PROVIDER)
    private readonly platform: PlatformMetricsProvider,
  ) {}

  async getDiscrepancy(
    workspaceId: string,
    adAccount: string | undefined,
    start: string | undefined,
    end: string | undefined,
  ): Promise<DiscrepancyReport> {
    const { startDay, endDay } = resolveRange(start, end);

    const truvo = await this.truvoByChannel(workspaceId, startDay, endDay);

    let platform: PlatformDailyMetric[] = [];
    const available = this.platform.isAvailable();
    if (available) {
      // TODO(live): o M10 mapeia click_id/utm → ad_account. Enquanto isso o
      // `channel` (utm_source) é o eixo de junção.
      platform = await this.platform.getDailyMetrics(workspaceId, adAccount, startDay, endDay);
    }

    const platformMap = new Map<string, PlatformDailyMetric>();
    for (const p of platform) platformMap.set(`${p.day}|${p.channel}`, p);

    // Junta por (day, channel) e computa delta.
    const rowsRaw: DiscrepancyRow[] = truvo.map((t) => {
      const p = platformMap.get(`${t.day}|${t.channel}`);
      const platformConversions = p ? p.platformConversions : null;
      return {
        day: t.day,
        channel: t.channel,
        truvo_conversions: t.conversions,
        truvo_revenue: t.revenue,
        platform_conversions: platformConversions,
        platform_revenue: p ? money(p.platformRevenue) : null,
        delta_conversions:
          platformConversions === null ? null : t.conversions - platformConversions,
        spike: false,
      };
    });

    const rows = available ? this.flagSpikes(rowsRaw) : rowsRaw;

    return {
      range: { start: startDay, end: endDay },
      ad_account: adAccount ?? null,
      platform_available: available,
      notice: available
        ? undefined
        : 'Dados da plataforma (M10) indisponíveis — exibindo apenas o lado Truvo reconciliado. O delta só é confiável após reconciliar com o gateway (M14) e comparar com a plataforma (regra: reconciliar antes de comparar).',
      rows,
    };
  }

  /* ─────────────────────────── Truvo (ClickHouse) ─────────────────────────── */

  private async truvoByChannel(
    workspaceId: string,
    startDay: string,
    endDay: string,
  ): Promise<TruvoChannelDay[]> {
    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          toString(toDate(timestamp))                                       AS day,
          if(utm_source = '', 'direct', utm_source)                         AS channel,
          countIf(event_name IN {revenue_events:Array(String)})             AS conversions,
          sumIf(value, event_name IN {revenue_events:Array(String)})
            - sumIf(value, event_name = {refund_event:String})             AS revenue
        FROM events
        WHERE workspace_id = {workspace_id:String}
          AND is_bot = 0                                                    -- regra 11
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
        GROUP BY day, channel
        HAVING conversions > 0
        ORDER BY day, channel`,
      query_params: {
        workspace_id: workspaceId,
        revenue_events: [...REVENUE_EVENTS],
        refund_event: REFUND_EVENT,
        start: dayToChDateTime(startDay),
        end: dayToChDateTime(addDays(endDay, 1)),
      },
      format: 'JSONEachRow',
    });
    const rows = (await rs.json()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      day: String(r['day']),
      channel: String(r['channel'] || 'direct'),
      conversions: Math.trunc(toNum(r['conversions'])),
      revenue: money(toNum(r['revenue'])),
    }));
  }

  /* ─────────────────────────────── spikes ─────────────────────────────── */

  /**
   * Marca `spike` quando o delta do dia é muito maior que o histórico do canal.
   * Heurística: por canal, ordena por dia; se |delta| > mean + 3*stddev dos
   * deltas anteriores do canal (com piso mínimo de amostra), sinaliza.
   */
  private flagSpikes(rows: DiscrepancyRow[]): DiscrepancyRow[] {
    const byChannel = new Map<string, DiscrepancyRow[]>();
    for (const r of rows) {
      const list = byChannel.get(r.channel) ?? [];
      list.push(r);
      byChannel.set(r.channel, list);
    }
    for (const list of byChannel.values()) {
      list.sort((a, b) => (a.day < b.day ? -1 : 1));
      const history: number[] = [];
      for (const r of list) {
        if (r.delta_conversions === null) continue;
        if (history.length >= 5) {
          const mean = avg(history);
          const sd = stddev(history, mean);
          if (Math.abs(r.delta_conversions) > mean + 3 * sd && Math.abs(r.delta_conversions) > 5) {
            r.spike = true;
          }
        }
        history.push(Math.abs(r.delta_conversions));
      }
    }
    return rows;
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stddev(xs: number[], mean: number): number {
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += (x - mean) ** 2;
  return Math.sqrt(acc / xs.length);
}
