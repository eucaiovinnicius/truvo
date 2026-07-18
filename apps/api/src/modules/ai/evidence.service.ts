import { Injectable, Logger } from '@nestjs/common';
// NOTA DE INTEGRAÇÃO: os tipos do evidence pack vêm de @truvo/db SÓ depois do barrel
// `schema/index.ts` re-exportar `./ai` na integração (ver schemaExports/openTODOs) —
// MESMO padrão do M7 (attributionSettings) / M16.
import type {
  AiEvidencePack,
  AiChannelEvidence,
  AiJourneyEvidence,
  AiReconciliationEvidence,
  AiAnomalyEvidence,
  AiSegment,
} from '@truvo/db';
import { AttributionService } from '../attribution/attribution.service';
import { getClickHouse } from './infra';
import { wilsonLowerBound } from './wilson';
import {
  ANOMALY_CVR_DROP,
  ANOMALY_MIN_PERSONS,
  ANOMALY_REVENUE_DROP,
  asNum,
  asStr,
  previousWindow,
  reconciliationThreshold,
  round,
  safeDiv,
  toChDate,
  type AiGoal,
  type AnalysisWindow,
} from './ai.constants';

/** Agregado bruto por canal lido de `journey_paths_daily`. */
interface ChannelAgg {
  channel: string;
  touches: number;
  persons: number;
  converters: number;
  conversions: number;
  revenue: number;
}

/**
 * M17 — Fase 1 (DETERMINÍSTICA). Monta o "evidence pack": TUDO calculado no
 * ClickHouse / TS, sem LLM (regras 12/13/17). Nenhum número aqui é inventado.
 *
 * Fontes:
 *  · journey_paths_daily (10-ai.sql) → CVR (Wilson), receita e LTV-proxy por canal.
 *  · AttributionService (M7)         → crédito multi-touch por canal + top jornadas
 *                                       (sequências) + spend/ROAS/CAC (via M10).
 *  · reconciliation_daily (M14)      → receita RECONCILIADA + gap (marca de incerteza).
 *
 * Toda leitura filtra workspace_id (regra 1); `journey_paths_daily`/
 * `reconciliation_daily` são bot-free por construção (regra 11 na MV).
 */
@Injectable()
export class AiEvidenceService {
  private readonly logger = new Logger(AiEvidenceService.name);

  constructor(private readonly attribution: AttributionService) {}

  /** Monta o evidence pack para (workspace, objetivo, janela, segmento). */
  async buildEvidencePack(
    workspaceId: string,
    goal: AiGoal,
    win: AnalysisWindow,
    segment: AiSegment | null | undefined,
  ): Promise<AiEvidencePack> {
    const reportWin = { start: win.start, end: win.end };

    // Fase 1 — leituras determinísticas em paralelo (independentes).
    const [jpdCurrent, jpdPrevious, recon, report, pathsRes, breakdown] = await Promise.all([
      this.readChannelAggs(workspaceId, win),
      this.readChannelAggs(workspaceId, previousWindow(win)),
      this.readReconciliation(workspaceId, win),
      this.attribution.report(workspaceId, {}, reportWin),
      this.attribution.paths(workspaceId, 15, {}, reportWin),
      this.attribution.campaignBreakdown(workspaceId, {}, undefined, 1000, reportWin),
    ]);

    // crédito multi-touch por canal (M7).
    const attrByChannel = new Map<string, { conversions: number; revenue: number }>();
    let totalAttributedRevenue = 0;
    for (const c of report.channels) {
      const rev = c.attributed_revenue ?? 0;
      totalAttributedRevenue += rev;
      attrByChannel.set(c.channel, {
        conversions: c.attributed_conversions ?? 0,
        revenue: rev,
      });
    }

    // spend por canal (M10 via AD_SPEND_PROVIDER; indisponível → vazio, regra 12).
    const spendAvailable = breakdown.spend_available === true;
    const spendByChannel = new Map<string, number>();
    if (spendAvailable) {
      for (const row of breakdown.rows) {
        if (row.spend == null) continue;
        spendByChannel.set(row.channel, (spendByChannel.get(row.channel) ?? 0) + row.spend);
      }
    }

    // une os canais das duas fontes (journey_paths_daily + atribuição).
    const channelKeys = new Set<string>([...jpdCurrent.keys(), ...attrByChannel.keys()]);
    const channels: AiChannelEvidence[] = [];
    for (const ch of channelKeys) {
      const agg = jpdCurrent.get(ch);
      const attr = attrByChannel.get(ch);
      const persons = agg?.persons ?? 0;
      const converters = agg?.converters ?? 0;
      const jpdRevenue = agg?.revenue ?? 0;
      const attributedConversions = attr ? attr.conversions : null;
      const attributedRevenue = attr ? attr.revenue : null;
      const spend = spendAvailable ? spendByChannel.get(ch) ?? null : null;

      channels.push({
        channel: ch,
        touches: agg?.touches ?? 0,
        persons,
        converters,
        conversions: agg?.conversions ?? 0,
        cvr: round(safeDiv(converters, persons)),
        cvr_wilson_lower: persons > 0 ? round(wilsonLowerBound(converters, persons)) : null,
        attributed_conversions: round(attributedConversions),
        attributed_revenue: round(attributedRevenue, 2),
        reconciled_revenue_share:
          attributedRevenue == null ? null : round(safeDiv(attributedRevenue, totalAttributedRevenue)),
        spend: spend == null ? null : round(spend, 2),
        roas: spend == null || attributedRevenue == null ? null : round(safeDiv(attributedRevenue, spend)),
        cac:
          spend == null || attributedConversions == null ? null : round(safeDiv(spend, attributedConversions)),
        ltv_proxy: round(safeDiv(jpdRevenue, converters), 2),
      });
    }

    channels.sort((a, b) => (b.attributed_revenue ?? 0) - (a.attributed_revenue ?? 0));

    // top jornadas (sequências de canal) — reusa o M7.
    let topJourneys: AiJourneyEvidence[] = pathsRes.paths.map((p) => ({
      path: p.path,
      conversions: p.conversions,
      revenue: p.revenue,
      avg_path_length: p.avg_path_length,
    }));

    // segmento por canal (determinístico). utm_* fica como filtro advisory (ver notes).
    const segChannel = segment?.channel;
    const filteredChannels = segChannel ? channels.filter((c) => c.channel === segChannel) : channels;
    if (segChannel) topJourneys = topJourneys.filter((j) => j.path.includes(segChannel));

    // reconciliação (M14) → totais + marca de incerteza (regra 12).
    const threshold = reconciliationThreshold();
    const reconciliation = this.summarizeReconciliation(recon, threshold);
    const uncertain = reconciliation.status === 'uncertain' || reconciliation.uncertain_days > 0;

    // anomalias determinísticas (janela atual vs. anterior).
    const anomalies = this.detectAnomalies(jpdCurrent, jpdPrevious, reconciliation, uncertain);

    // totais globais (uniq/soma corretos, não a soma de uniq por canal).
    const totalsGlobal = await this.readGlobalTotals(workspaceId, win);

    const pack: AiEvidencePack = {
      generated_at: new Date().toISOString(),
      goal,
      window: { start: win.start.toISOString(), end: win.end.toISOString(), days: win.days },
      segment: segment ?? null,
      spend_available: spendAvailable,
      attribution_model: report.model,
      totals: {
        conversions: report.totals.conversions,
        attributed_revenue: round(totalAttributedRevenue, 2),
        reconciled_revenue: reconciliation.gateway_revenue,
        unique_converters: totalsGlobal.converters,
      },
      reconciliation,
      uncertain,
      channels: filteredChannels,
      top_journeys: topJourneys,
      anomalies,
    };
    return pack;
  }

  // ─────────────────────── leitura journey_paths_daily ───────────────────────

  /** Agregados por canal na janela (10-ai.sql). Regra 1: workspace_id sempre no WHERE. */
  private async readChannelAggs(workspaceId: string, win: AnalysisWindow): Promise<Map<string, ChannelAgg>> {
    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          channel                AS channel,
          countMerge(touches)    AS touches,
          uniqMerge(persons)     AS persons,
          uniqMerge(converters)  AS converters,
          uniqMerge(conversions) AS conversions,
          sumMerge(revenue)      AS revenue
        FROM journey_paths_daily
        WHERE workspace_id = {ws:String}
          AND day >= {start:Date}
          AND day <= {end:Date}
        GROUP BY channel`,
      query_params: { ws: workspaceId, start: toChDate(win.start), end: toChDate(win.end) },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<Record<string, unknown>>();
    const out = new Map<string, ChannelAgg>();
    for (const r of rows) {
      const channel = asStr(r.channel) || 'direct';
      out.set(channel, {
        channel,
        touches: asNum(r.touches),
        persons: asNum(r.persons),
        converters: asNum(r.converters),
        conversions: asNum(r.conversions),
        revenue: asNum(r.revenue),
      });
    }
    return out;
  }

  /** Totais globais (uniq correto) da janela. */
  private async readGlobalTotals(
    workspaceId: string,
    win: AnalysisWindow,
  ): Promise<{ converters: number; conversions: number; revenue: number }> {
    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          uniqMerge(converters)  AS converters,
          uniqMerge(conversions) AS conversions,
          sumMerge(revenue)      AS revenue
        FROM journey_paths_daily
        WHERE workspace_id = {ws:String}
          AND day >= {start:Date}
          AND day <= {end:Date}`,
      query_params: { ws: workspaceId, start: toChDate(win.start), end: toChDate(win.end) },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<Record<string, unknown>>();
    const r = rows[0];
    return {
      converters: r ? asNum(r.converters) : 0,
      conversions: r ? asNum(r.conversions) : 0,
      revenue: r ? asNum(r.revenue) : 0,
    };
  }

  // ─────────────────────── reconciliação (M14) ───────────────────────

  private async readReconciliation(
    workspaceId: string,
    win: AnalysisWindow,
  ): Promise<{ truvo: number; gateway: number; uncertainDays: number; maxGap: number | null }> {
    try {
      const ch = getClickHouse();
      const rs = await ch.query({
        query: `
          SELECT
            sum(truvo_revenue)              AS truvo_revenue,
            sum(gateway_revenue)            AS gateway_revenue,
            countIf(status = 'uncertain')   AS uncertain_days,
            max(reconciliation_gap)         AS max_gap
          FROM reconciliation_daily FINAL
          WHERE workspace_id = {ws:String}
            AND day >= {start:Date}
            AND day <= {end:Date}`,
        query_params: { ws: workspaceId, start: toChDate(win.start), end: toChDate(win.end) },
        format: 'JSONEachRow',
      });
      const rows = await rs.json<Record<string, unknown>>();
      const r = rows[0];
      return {
        truvo: r ? asNum(r.truvo_revenue) : 0,
        gateway: r ? asNum(r.gateway_revenue) : 0,
        uncertainDays: r ? asNum(r.uncertain_days) : 0,
        maxGap: r && r.max_gap != null ? asNum(r.max_gap) : null,
      };
    } catch (err) {
      // best-effort: sem reconciliação, seguimos com "no_ground_truth".
      this.logger.warn(`reconciliação indisponível (ws=${workspaceId}): ${errMessage(err)}`);
      return { truvo: 0, gateway: 0, uncertainDays: 0, maxGap: null };
    }
  }

  private summarizeReconciliation(
    recon: { truvo: number; gateway: number; uncertainDays: number; maxGap: number | null },
    threshold: number,
  ): AiReconciliationEvidence {
    const hasGroundTruth = recon.gateway > 0;
    const gap = hasGroundTruth ? Math.abs(recon.truvo - recon.gateway) / recon.gateway : null;
    const status = !hasGroundTruth
      ? 'no_ground_truth'
      : (gap ?? 0) > threshold || recon.uncertainDays > 0
        ? 'uncertain'
        : 'reconciled';
    return {
      truvo_revenue: round(recon.truvo, 2) ?? 0,
      gateway_revenue: hasGroundTruth ? round(recon.gateway, 2) : null,
      reconciliation_gap: gap == null ? null : round(gap),
      uncertain_days: recon.uncertainDays,
      status,
    };
  }

  // ─────────────────────── anomalias (determinísticas) ───────────────────────

  /**
   * Compara a janela atual com a anterior (igual duração) por canal. Sinaliza quedas
   * relevantes de CVR (Wilson) e receita, e a incerteza de reconciliação. É 100%
   * determinístico — o LLM não participa da detecção (regra 13). O runs.service
   * encaminha cada anomalia ao M12 (NOTIFICATION_PROVIDER).
   */
  private detectAnomalies(
    current: Map<string, ChannelAgg>,
    previous: Map<string, ChannelAgg>,
    reconciliation: AiReconciliationEvidence,
    uncertain: boolean,
  ): AiAnomalyEvidence[] {
    const out: AiAnomalyEvidence[] = [];

    for (const [channel, cur] of current) {
      const prev = previous.get(channel);
      if (!prev) continue;

      // CVR (usa Wilson lower-bound atual vs. CVR pontual anterior; exige amostra).
      if (cur.persons >= ANOMALY_MIN_PERSONS && prev.persons > 0) {
        const curCvr = wilsonLowerBound(cur.converters, cur.persons);
        const prevCvr = prev.converters / prev.persons;
        const change = safeDiv(curCvr - prevCvr, prevCvr);
        if (prevCvr > 0 && change != null && change <= -ANOMALY_CVR_DROP) {
          out.push({
            channel,
            metric: 'cvr',
            current: round(curCvr),
            previous: round(prevCvr),
            change_pct: round(change),
            severity: 'warning',
            note: `Queda de CVR (Wilson) de ${(prevCvr * 100).toFixed(2)}% para ${(curCvr * 100).toFixed(2)}%.`,
          });
        }
      }

      // Receita.
      if (prev.revenue > 0) {
        const change = safeDiv(cur.revenue - prev.revenue, prev.revenue);
        if (change != null && change <= -ANOMALY_REVENUE_DROP) {
          out.push({
            channel,
            metric: 'revenue',
            current: round(cur.revenue, 2),
            previous: round(prev.revenue, 2),
            change_pct: round(change),
            severity: 'warning',
            note: `Queda de receita de ${prev.revenue.toFixed(2)} para ${cur.revenue.toFixed(2)}.`,
          });
        }
      }
    }

    // Incerteza de reconciliação (regra 12) — anomalia global.
    if (uncertain) {
      out.push({
        channel: '*',
        metric: 'reconciliation',
        current: reconciliation.reconciliation_gap,
        previous: null,
        change_pct: null,
        severity: 'critical',
        note: `Reconciliação incerta (gap=${reconciliation.reconciliation_gap ?? 'n/d'}, dias incertos=${reconciliation.uncertain_days}). Números de receita podem não ser confiáveis.`,
      });
    }

    return out;
  }
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
