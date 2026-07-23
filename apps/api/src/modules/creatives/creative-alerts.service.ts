import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  creativeAlertLog,
  type CreativeAlertType,
  type CreativePlatform,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { NotificationService } from '../notifications/notifications.service';
import { queryDailySeries, type DailyKeyedPoint } from './creatives-ch';
import {
  ALERT_THRESHOLDS,
  addDays,
  resolveDayRange,
  round,
  safeDiv,
} from './creatives.constants';

/** Um alerta de criativo avaliado (payload entregue ao M12). */
export interface CreativeAlert {
  type: CreativeAlertType;
  platform: string;
  ad_id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  dedup_key: string;
}

export interface CreativeAlertsResult {
  range: { start: string; end: string };
  evaluated_at: string;
  thresholds: typeof ALERT_THRESHOLDS;
  count: number;
  alerts: CreativeAlert[];
}

interface AdSeries {
  platform: string;
  adId: string;
  points: DailyKeyedPoint[];
}

/**
 * M10 — ALERTAS DE CRIATIVO (PRD §7 M10). Avalia fadiga, discrepância, top
 * performer e gasto-sem-conversão sobre a série diária (reportado + real), MONTA o
 * payload e ROTEIA pelo M12 — Notificações & Alertas.
 *
 * A ENTREGA (email/Slack/in-app) é do M12 (onda futura). Aqui: avaliamos, gravamos
 * no histórico `creative_alert_log` (dedup por dia — não spammar) e chamamos
 * `dispatch`, que HOJE loga e marca o ponto de integração. MESMO padrão do M5
 * (FunnelAlertsService) e do M14.
 */
@Injectable()
export class CreativeAlertsService {
  private readonly logger = new Logger(CreativeAlertsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Avalia os alertas do workspace na janela dada. Fadiga precisa de 2 janelas
   * (compara os últimos N dias com os N anteriores) — por isso o scan usa uma
   * janela dobrada quando o cliente não passa datas.
   */
  async getAlerts(
    workspaceId: string,
    dto: { platform?: string; start?: string; end?: string; persist?: boolean } = {},
  ): Promise<CreativeAlertsResult> {
    // Default: últimos 14 dias (2× 7d) p/ suportar a comparação de fadiga.
    const range = resolveDayRange(dto.start, dto.end, ALERT_THRESHOLDS.topSustainedDays * 2);
    const series = await queryDailySeries(workspaceId, range, dto.platform);

    const byAd = groupByAd(series);
    const alerts: CreativeAlert[] = [];
    for (const ad of byAd) {
      alerts.push(...this.evaluateAd(ad, range.endDay));
    }

    if (dto.persist !== false && alerts.length > 0) {
      await this.persist(workspaceId, alerts);
    }
    // Roteia cada alerta pelo M12 (NotificationService).
    await Promise.all(alerts.map((a) => this.dispatch(workspaceId, a)));

    return {
      range: { start: range.startDay, end: range.endDay },
      evaluated_at: new Date().toISOString(),
      thresholds: ALERT_THRESHOLDS,
      count: alerts.length,
      alerts,
    };
  }

  /** Aplica as 4 regras a UM criativo. */
  private evaluateAd(ad: AdSeries, dayBucket: string): CreativeAlert[] {
    const out: CreativeAlert[] = [];
    const t = ALERT_THRESHOLDS;

    // agregados da janela inteira
    let spend = 0;
    let realRevenue = 0;
    let reportedRevenue = 0;
    let realConversions = 0;
    let topDays = 0;
    for (const p of ad.points) {
      spend += p.spend;
      realRevenue += p.realRevenue - p.refunds;
      reportedRevenue += p.platformRevenue;
      realConversions += p.orders;
      const dayRoas = safeDiv(p.realRevenue - p.refunds, p.spend);
      if (dayRoas !== null && dayRoas > t.topRoas) topDays += 1;
    }
    const roasReal = safeDiv(realRevenue, spend);
    const roasReported = safeDiv(reportedRevenue, spend);
    const mk = (type: CreativeAlertType) =>
      `${ad.platform}|${ad.adId}|${type}|${dayBucket}`;

    // 1) Gasto sem conversão: spend > X e 0 conversões reais.
    if (spend > t.spendNoConversion && realConversions === 0) {
      out.push({
        type: 'spend_no_conversion',
        platform: ad.platform,
        ad_id: ad.adId,
        severity: 'critical',
        message: `Gasto de ${round(spend, 2)} sem nenhuma conversão real — considerar pausar.`,
        details: { spend: round(spend, 2), real_conversions: 0, threshold: t.spendNoConversion },
        dedup_key: mk('spend_no_conversion'),
      });
    }

    // 2) Discrepância alta: |delta_percent| > X (com spend e ambos os lados).
    if (roasReal !== null && roasReported !== null && roasReal > 0) {
      const deltaPct = (roasReported - roasReal) / roasReal;
      if (Math.abs(deltaPct) > t.discrepancyDeltaPct) {
        out.push({
          type: 'discrepancy',
          platform: ad.platform,
          ad_id: ad.adId,
          severity: 'warning',
          message: `Delta reportado vs real de ${Math.round(deltaPct * 100)}% — verificar tracking.`,
          details: {
            roas_reported: round(roasReported, 4),
            roas_real: round(roasReal, 4),
            delta_percent: round(deltaPct, 4),
            threshold: t.discrepancyDeltaPct,
          },
          dedup_key: mk('discrepancy'),
        });
      }
    }

    // 3) Fadiga: ROAS real caiu > X% nos últimos N dias vs. os N anteriores.
    const fatigue = this.evaluateFatigue(ad);
    if (fatigue) {
      out.push({
        type: 'fatigue',
        platform: ad.platform,
        ad_id: ad.adId,
        severity: 'warning',
        message: `ROAS real caiu ${Math.round(fatigue.dropPct * 100)}% em ${
          ALERT_THRESHOLDS.topSustainedDays
        } dias — sinal de fadiga, considerar pausar/renovar.`,
        details: {
          roas_recent: round(fatigue.recent, 4),
          roas_previous: round(fatigue.previous, 4),
          drop_percent: round(fatigue.dropPct, 4),
          threshold: t.fatigueRoasDropPct,
        },
        dedup_key: mk('fatigue'),
      });
    }

    // 4) Top performer: ROAS real > X em N+ dias → aumentar budget.
    if (roasReal !== null && roasReal > t.topRoas && topDays >= t.topSustainedDays) {
      out.push({
        type: 'top_performer',
        platform: ad.platform,
        ad_id: ad.adId,
        severity: 'info',
        message: `ROAS real de ${round(roasReal, 2)}x sustentado por ${topDays} dias — considerar aumentar budget.`,
        details: {
          roas_real: round(roasReal, 4),
          sustained_days: topDays,
          threshold_roas: t.topRoas,
          threshold_days: t.topSustainedDays,
        },
        dedup_key: mk('top_performer'),
      });
    }

    return out;
  }

  /** Compara ROAS real dos últimos N dias com os N anteriores. */
  private evaluateFatigue(
    ad: AdSeries,
  ): { recent: number; previous: number; dropPct: number } | null {
    const n = ALERT_THRESHOLDS.topSustainedDays;
    if (ad.points.length === 0) return null;
    const lastDay = ad.points[ad.points.length - 1]?.day;
    if (!lastDay) return null;
    const recentStart = addDays(lastDay, -(n - 1));
    const prevStart = addDays(lastDay, -(2 * n - 1));

    let recSpend = 0;
    let recRev = 0;
    let prevSpend = 0;
    let prevRev = 0;
    for (const p of ad.points) {
      const net = p.realRevenue - p.refunds;
      if (p.day >= recentStart) {
        recSpend += p.spend;
        recRev += net;
      } else if (p.day >= prevStart) {
        prevSpend += p.spend;
        prevRev += net;
      }
    }
    if (recSpend < ALERT_THRESHOLDS.fatigueMinSpend || prevSpend < ALERT_THRESHOLDS.fatigueMinSpend) {
      return null; // amostra insuficiente — evita ruído
    }
    const recent = safeDiv(recRev, recSpend);
    const previous = safeDiv(prevRev, prevSpend);
    if (recent === null || previous === null || previous <= 0) return null;
    const dropPct = (previous - recent) / previous;
    if (dropPct < ALERT_THRESHOLDS.fatigueRoasDropPct) return null;
    return { recent, previous, dropPct };
  }

  /**
   * Persiste os alertas novos no histórico (dedup por dedup_key). Defesa em
   * profundidade: o M12 também de-dup na entrega.
   */
  private async persist(workspaceId: string, alerts: CreativeAlert[]): Promise<void> {
    const keys = alerts.map((a) => a.dedup_key);
    let existing = new Set<string>();
    try {
      const rows = await this.db
        .select({ dedupKey: creativeAlertLog.dedupKey })
        .from(creativeAlertLog)
        .where(
          and(
            eq(creativeAlertLog.workspaceId, workspaceId),
            inArray(creativeAlertLog.dedupKey, keys),
          ),
        );
      existing = new Set(rows.map((r) => r.dedupKey));
    } catch (err) {
      // Sem a tabela (schema não migrado) → segue sem persistir (não derruba a rota).
      this.logger.warn(`histórico de alertas indisponível: ${errMsg(err)}`);
      return;
    }

    const fresh = alerts.filter((a) => !existing.has(a.dedup_key));
    if (fresh.length === 0) return;
    const now = new Date();
    try {
      await this.db.insert(creativeAlertLog).values(
        fresh.map((a) => ({
          id: `cal_${ulid()}`,
          workspaceId,
          platform: a.platform as CreativePlatform,
          adId: a.ad_id,
          type: a.type,
          severity: a.severity,
          message: a.message,
          details: a.details,
          dedupKey: a.dedup_key,
          status: 'open' as const,
          triggeredAt: now,
          notifiedAt: null,
        })),
      );
    } catch (err) {
      this.logger.warn(`falha ao gravar histórico de alertas: ${errMsg(err)}`);
    }
  }

  /**
   * Roteia o alerta pelo M12 (NotificationService): resolve regra/preferências/
   * canais + dedup por `dedup_key` e entrega in-app/email/Slack. O `type` mapeia p/
   * o registry ('creative.fatigue'/'creative.discrepancy'/…).
   */
  private async dispatch(workspaceId: string, alert: CreativeAlert): Promise<void> {
    const type = String(alert.type).startsWith('creative.')
      ? String(alert.type)
      : `creative.${alert.type}`;
    try {
      await this.notifications.dispatch(workspaceId, type, {
        data: {
          creative_name: alert.ad_id,
          ad_id: alert.ad_id,
          platform: alert.platform,
          ...alert.details,
        },
        body: alert.message,
        severity: alert.severity,
        dedupId: alert.dedup_key,
      });
    } catch (err) {
      // best-effort: a entrega de notificação NUNCA pode derrubar o endpoint de
      // alertas (que só lê/avalia). O alerta já foi calculado e persistido.
      this.logger.warn(`dispatch de alerta de criativo falhou (ws=${workspaceId}): ${errMsg(err)}`);
    }
  }
}

function groupByAd(series: DailyKeyedPoint[]): AdSeries[] {
  const map = new Map<string, AdSeries>();
  for (const p of series) {
    if (!p.adId) continue;
    const key = `${p.platform}|${p.adId}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { platform: p.platform, adId: p.adId, points: [] };
      map.set(key, entry);
    }
    entry.points.push(p);
  }
  for (const ad of map.values()) ad.points.sort((a, b) => (a.day < b.day ? -1 : 1));
  return Array.from(map.values());
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
