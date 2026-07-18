import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
// NOTA DE INTEGRAÇÃO: `attributionSettings` e os tipos são expostos por @truvo/db
// SÓ depois do barrel `schema/index.ts` re-exportar `./attribution` na integração
// da onda M7 (ver schemaExports/openTODOs) — MESMO padrão do M5/M6/M8.
import {
  attributionSettings,
  ATTRIBUTION_DEFAULTS,
  type AttributionModel,
  type AttributionSettings,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { getClickHouse } from './infra';
import { computeWeights } from './attribution-models';
import {
  AD_SPEND_PROVIDER,
  type AdSpendProvider,
  type AdSpendRow,
} from './ad-spend.provider';
import {
  CHANNEL_RESOLVE_SQL,
  coerceModel,
  coerceWindowDays,
  DEFAULT_HALF_LIFE_DAYS,
  round,
  safeDiv,
  toChDateTime,
  windowFloor,
  type ReportWindow,
} from './attribution.constants';

// ───────────────────────────── tipos internos ─────────────────────────────

/** Um toque de marketing já normalizado (uma linha de `touchpoints`). */
interface Touch {
  ts: number; // ms epoch
  channel: string; // channel_resolved
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  orderId: string;
  value: number;
  eventId: string;
}

/** Uma conversão + o caminho de toques dentro da janela de atribuição. */
interface ConversionPath {
  orderId: string;
  convTs: number;
  revenue: number;
  touches: Touch[]; // ordenados por ts asc; inclui o toque de conversão
}

/** Acumulador de crédito por canal. */
interface ChannelAgg {
  channel: string;
  attributedConversions: number; // fracionário (soma dos pesos)
  attributedRevenue: number;
  lastTouchConversions: number; // inteiro (canal foi o último toque)
  assistedConversions: number; // inteiro (participou, mas não foi o último)
}

/** Acumulador de crédito por campanha (campaign-breakdown). */
interface CampaignAgg {
  channel: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  attributedConversions: number;
  attributedRevenue: number;
}

// ───────────────────────────── helpers de parsing ─────────────────────────────

const asNum = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
};
const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Config efetiva (query param > settings > defaults de fábrica). */
export interface ResolvedConfig {
  model: AttributionModel;
  windowDays: number;
  halfLifeDays: number;
}

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(AD_SPEND_PROVIDER) private readonly adSpend: AdSpendProvider,
  ) {}

  // ─────────────────────────── settings (Postgres) ───────────────────────────

  /** Config do workspace (linha de settings) ou defaults de fábrica. */
  async getSettings(workspaceId: string): Promise<AttributionSettings> {
    const rows = await this.db
      .select()
      .from(attributionSettings)
      .where(eq(attributionSettings.workspaceId, workspaceId))
      .limit(1);
    const row = rows[0];
    if (row) return row;
    return {
      workspaceId,
      defaultModel: ATTRIBUTION_DEFAULTS.model,
      defaultWindowDays: ATTRIBUTION_DEFAULTS.windowDays,
      timeDecayHalfLifeDays: ATTRIBUTION_DEFAULTS.timeDecayHalfLifeDays,
      updatedAt: new Date(),
    };
  }

  /** Upsert idempotente da config do workspace. */
  async updateSettings(
    workspaceId: string,
    patch: {
      default_model?: AttributionModel;
      default_window_days?: number;
      time_decay_half_life_days?: number;
    },
  ): Promise<AttributionSettings> {
    const current = await this.getSettings(workspaceId);
    const next = {
      workspaceId,
      defaultModel: patch.default_model ?? current.defaultModel,
      defaultWindowDays: patch.default_window_days ?? current.defaultWindowDays,
      timeDecayHalfLifeDays: patch.time_decay_half_life_days ?? current.timeDecayHalfLifeDays,
      updatedAt: new Date(),
    };
    await this.db
      .insert(attributionSettings)
      .values(next)
      .onConflictDoUpdate({
        target: attributionSettings.workspaceId,
        set: {
          defaultModel: next.defaultModel,
          defaultWindowDays: next.defaultWindowDays,
          timeDecayHalfLifeDays: next.timeDecayHalfLifeDays,
          updatedAt: next.updatedAt,
        },
      });
    return next;
  }

  /** Resolve a config efetiva: query param > settings > defaults. */
  async resolveConfig(
    workspaceId: string,
    override: { model?: string; windowDays?: number },
  ): Promise<ResolvedConfig> {
    const s = await this.getSettings(workspaceId);
    return {
      model: coerceModel(override.model, s.defaultModel),
      windowDays: coerceWindowDays(override.windowDays, s.defaultWindowDays),
      halfLifeDays: s.timeDecayHalfLifeDays > 0 ? s.timeDecayHalfLifeDays : DEFAULT_HALF_LIFE_DAYS,
    };
  }

  // ───────────────────── leitura de caminhos (ClickHouse) ─────────────────────

  /**
   * Busca, por canonical_id que CONVERTEU em [start, end), todos os toques em
   * [start - windowDays, end) e reconstrói os caminhos de conversão. O crédito é
   * distribuído depois, em TS, por modelo.
   *
   * Invariantes: `workspace_id` (regra 1) + `is_bot = 0` (regra 11) sempre no WHERE
   * (lê a tabela BASE `touchpoints`, sem depender da VIEW opcional). Nenhum valor do
   * cliente entra no SQL a não ser por `query_params`; a classificação de canal é
   * uma constante do servidor (CHANNEL_RESOLVE_SQL).
   */
  async fetchConversionPaths(
    workspaceId: string,
    win: ReportWindow,
    windowDays: number,
  ): Promise<ConversionPath[]> {
    const minTs = windowFloor(win.start, windowDays);
    const windowMs = windowDays * 86_400_000;

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          canonical_id AS canonical_id,
          groupArray((
            toUnixTimestamp64Milli(ts),
            ${CHANNEL_RESOLVE_SQL},
            utm_source,
            utm_medium,
            utm_campaign,
            order_id,
            value,
            event_id
          )) AS touches
        FROM touchpoints
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND ts >= {min_ts:DateTime64(3)}
          AND ts <  {end:DateTime64(3)}
        GROUP BY canonical_id
        HAVING countIf(order_id != '' AND ts >= {start:DateTime64(3)}) > 0`,
      query_params: {
        ws: workspaceId,
        min_ts: toChDateTime(minTs),
        start: toChDateTime(win.start),
        end: toChDateTime(win.end),
      },
      format: 'JSONEachRow',
    });

    const rows = await rs.json<{ canonical_id: string; touches: unknown[] }>();
    const startMs = win.start.getTime();
    const endMs = win.end.getTime();
    const paths: ConversionPath[] = [];

    for (const row of rows) {
      const touches = this.parseTouches(row.touches);
      if (touches.length === 0) continue;
      touches.sort((a, b) => a.ts - b.ts);

      // Conversões desta pessoa dentro da janela de relatório (dedup por order_id,
      // mantendo o toque de MAIOR ts como o instante da conversão).
      const convByOrder = new Map<string, Touch>();
      for (const t of touches) {
        if (t.orderId === '' || t.ts < startMs || t.ts >= endMs) continue;
        const prev = convByOrder.get(t.orderId);
        if (!prev || t.ts > prev.ts) convByOrder.set(t.orderId, t);
      }
      if (convByOrder.size === 0) continue;

      for (const conv of convByOrder.values()) {
        const floor = conv.ts - windowMs;
        const path = touches.filter((t) => t.ts >= floor && t.ts <= conv.ts);
        if (path.length === 0) continue; // não deve ocorrer (o próprio toque qualifica)
        paths.push({
          orderId: conv.orderId,
          convTs: conv.ts,
          revenue: conv.value,
          touches: path,
        });
      }
    }
    return paths;
  }

  /** Parseia o groupArray de tuplas em Touch[], deduplicando por event_id. */
  private parseTouches(raw: unknown[]): Touch[] {
    const byEvent = new Map<string, Touch>();
    const out: Touch[] = [];
    let synthetic = 0;
    for (const item of raw) {
      if (!Array.isArray(item)) continue;
      const touch: Touch = {
        ts: asNum(item[0]),
        channel: asStr(item[1]) || 'direct',
        utmSource: asStr(item[2]),
        utmMedium: asStr(item[3]),
        utmCampaign: asStr(item[4]),
        orderId: asStr(item[5]),
        value: asNum(item[6]),
        eventId: asStr(item[7]),
      };
      // ReplacingMergeTree pode ter reinserção do mesmo event_id: colapsa aqui.
      const key = touch.eventId !== '' ? touch.eventId : `__syn_${synthetic++}`;
      if (byEvent.has(key)) continue;
      byEvent.set(key, touch);
      out.push(touch);
    }
    return out;
  }

  // ──────────────────────── agregação de crédito (TS) ────────────────────────

  /** Distribui crédito por canal para UM modelo, sobre todos os caminhos. */
  private aggregateByChannel(
    paths: ConversionPath[],
    model: AttributionModel,
    halfLifeDays: number,
  ): { channels: Map<string, ChannelAgg>; totalConversions: number; totalRevenue: number } {
    const channels = new Map<string, ChannelAgg>();
    let totalConversions = 0;
    let totalRevenue = 0;

    const bump = (ch: string): ChannelAgg => {
      let agg = channels.get(ch);
      if (!agg) {
        agg = {
          channel: ch,
          attributedConversions: 0,
          attributedRevenue: 0,
          lastTouchConversions: 0,
          assistedConversions: 0,
        };
        channels.set(ch, agg);
      }
      return agg;
    };

    for (const p of paths) {
      totalConversions += 1;
      totalRevenue += p.revenue;

      const tsList = p.touches.map((t) => t.ts);
      const weights = computeWeights(model, tsList, p.convTs, halfLifeDays);

      const lastTouch = p.touches[p.touches.length - 1];
      const lastChannel = lastTouch ? lastTouch.channel : 'direct';
      const seen = new Set<string>();

      for (let i = 0; i < p.touches.length; i++) {
        const t = p.touches[i];
        if (!t) continue;
        const w = weights[i] ?? 0;
        const agg = bump(t.channel);
        agg.attributedConversions += w;
        agg.attributedRevenue += w * p.revenue;
        seen.add(t.channel);
      }

      bump(lastChannel).lastTouchConversions += 1;
      for (const ch of seen) {
        if (ch !== lastChannel) bump(ch).assistedConversions += 1;
      }
    }

    return { channels, totalConversions, totalRevenue };
  }

  // ─────────────────────────────── /report ───────────────────────────────

  /**
   * Relatório de atribuição por canal para UM modelo: conversões atribuídas,
   * receita atribuída, last-touch e assisted (PRD §7 M7).
   */
  async report(
    workspaceId: string,
    override: { model?: string; windowDays?: number },
    win: ReportWindow,
  ) {
    const cfg = await this.resolveConfig(workspaceId, override);
    const paths = await this.fetchConversionPaths(workspaceId, win, cfg.windowDays);
    const { channels, totalConversions, totalRevenue } = this.aggregateByChannel(
      paths,
      cfg.model,
      cfg.halfLifeDays,
    );

    const rows = Array.from(channels.values())
      .map((c) => ({
        channel: c.channel,
        attributed_conversions: round(c.attributedConversions, 4),
        attributed_revenue: round(c.attributedRevenue, 2),
        last_touch_conversions: c.lastTouchConversions,
        assisted_conversions: c.assistedConversions,
        revenue_share: round(safeDiv(c.attributedRevenue, totalRevenue), 4),
      }))
      .sort((a, b) => (b.attributed_revenue ?? 0) - (a.attributed_revenue ?? 0));

    return {
      model: cfg.model,
      window_days: cfg.windowDays,
      time_decay_half_life_days: cfg.model === 'time_decay' ? cfg.halfLifeDays : undefined,
      report_window: { start: win.start.toISOString(), end: win.end.toISOString() },
      totals: {
        conversions: totalConversions,
        revenue: round(totalRevenue, 2),
      },
      channels: rows,
    };
  }

  // ─────────────────────────────── /compare ───────────────────────────────

  /**
   * Compara VÁRIOS modelos lado a lado por canal (mesma janela). Uma única leitura
   * de caminhos; cada modelo reparte o crédito sobre os mesmos caminhos.
   */
  async compare(
    workspaceId: string,
    models: AttributionModel[],
    override: { windowDays?: number },
    win: ReportWindow,
  ) {
    const cfg = await this.resolveConfig(workspaceId, override);
    const paths = await this.fetchConversionPaths(workspaceId, win, cfg.windowDays);

    // canal → { modelo → {conversions, revenue} }
    const byChannel = new Map<string, Record<string, { conversions: number; revenue: number }>>();
    let totalConversions = 0;
    let totalRevenue = 0;

    models.forEach((model, mi) => {
      const { channels, totalConversions: tc, totalRevenue: tr } = this.aggregateByChannel(
        paths,
        model,
        cfg.halfLifeDays,
      );
      if (mi === 0) {
        totalConversions = tc;
        totalRevenue = tr;
      }
      for (const c of channels.values()) {
        let entry = byChannel.get(c.channel);
        if (!entry) {
          entry = {};
          byChannel.set(c.channel, entry);
        }
        entry[model] = {
          conversions: round(c.attributedConversions, 4) ?? 0,
          revenue: round(c.attributedRevenue, 2) ?? 0,
        };
      }
    });

    const channels = Array.from(byChannel.entries())
      .map(([channel, byModel]) => {
        const models_: Record<string, { conversions: number; revenue: number }> = {};
        for (const m of models) models_[m] = byModel[m] ?? { conversions: 0, revenue: 0 };
        return { channel, models: models_ };
      })
      .sort((a, b) => channelTotal(b.models) - channelTotal(a.models));

    return {
      models,
      window_days: cfg.windowDays,
      report_window: { start: win.start.toISOString(), end: win.end.toISOString() },
      totals: { conversions: totalConversions, revenue: round(totalRevenue, 2) },
      channels,
    };
  }

  // ──────────────────────────────── /paths ────────────────────────────────

  /**
   * Top-N caminhos de conversão (sequência de canais). Dedup de canal consecutivo
   * (colapsa remarketing seguido no mesmo canal). Agrega contagem + receita.
   */
  async paths(
    workspaceId: string,
    limit: number,
    override: { windowDays?: number },
    win: ReportWindow,
  ) {
    const cfg = await this.resolveConfig(workspaceId, override);
    const conversionPaths = await this.fetchConversionPaths(workspaceId, win, cfg.windowDays);

    const agg = new Map<
      string,
      { path: string[]; conversions: number; revenue: number; touchTotal: number }
    >();
    let totalConversions = 0;
    let totalRevenue = 0;

    for (const p of conversionPaths) {
      totalConversions += 1;
      totalRevenue += p.revenue;
      const seq = collapseConsecutive(p.touches.map((t) => t.channel));
      const key = seq.join(' > ');
      let entry = agg.get(key);
      if (!entry) {
        entry = { path: seq, conversions: 0, revenue: 0, touchTotal: 0 };
        agg.set(key, entry);
      }
      entry.conversions += 1;
      entry.revenue += p.revenue;
      entry.touchTotal += seq.length;
    }

    const top = Array.from(agg.values())
      .sort((a, b) => b.conversions - a.conversions || b.revenue - a.revenue)
      .slice(0, limit)
      .map((e) => ({
        path: e.path,
        conversions: e.conversions,
        revenue: round(e.revenue, 2),
        avg_path_length: round(e.touchTotal / e.conversions, 2),
      }));

    return {
      window_days: cfg.windowDays,
      report_window: { start: win.start.toISOString(), end: win.end.toISOString() },
      totals: { conversions: totalConversions, revenue: round(totalRevenue, 2), unique_paths: agg.size },
      paths: top,
    };
  }

  // ──────────────────────── /campaign-breakdown ────────────────────────

  /**
   * Breakdown por canal→campanha com crédito do modelo escolhido + spend/ROAS/CAC.
   * `channelFilter` limita a um canal. Conjunto (utm_content) e Anúncio (utm_term)
   * NÃO existem em `touchpoints` hoje — ver TODO(live) no 08-attribution.sql.
   */
  async campaignBreakdown(
    workspaceId: string,
    override: { model?: string; windowDays?: number },
    channelFilter: string | undefined,
    limit: number,
    win: ReportWindow,
  ) {
    const cfg = await this.resolveConfig(workspaceId, override);
    const paths = await this.fetchConversionPaths(workspaceId, win, cfg.windowDays);

    const byCampaign = new Map<string, CampaignAgg>();
    const bump = (t: Touch): CampaignAgg => {
      const key = `${t.channel} ${t.utmSource} ${t.utmMedium} ${t.utmCampaign}`;
      let agg = byCampaign.get(key);
      if (!agg) {
        agg = {
          channel: t.channel,
          utmSource: t.utmSource,
          utmMedium: t.utmMedium,
          utmCampaign: t.utmCampaign,
          attributedConversions: 0,
          attributedRevenue: 0,
        };
        byCampaign.set(key, agg);
      }
      return agg;
    };

    for (const p of paths) {
      const tsList = p.touches.map((t) => t.ts);
      const weights = computeWeights(cfg.model, tsList, p.convTs, cfg.halfLifeDays);
      for (let i = 0; i < p.touches.length; i++) {
        const t = p.touches[i];
        if (!t) continue;
        if (channelFilter && t.channel !== channelFilter) continue;
        const w = weights[i] ?? 0;
        if (w === 0) continue;
        const agg = bump(t);
        agg.attributedConversions += w;
        agg.attributedRevenue += w * p.revenue;
      }
    }

    // spend do provider (M10). Indisponível hoje → mapa vazio, ROAS/CAC null.
    const spendAvailable = this.adSpend.isAvailable();
    const spendByCampaign = new Map<string, number>();
    const spendByChannel = new Map<string, number>();
    if (spendAvailable) {
      let spendRows: AdSpendRow[] = [];
      try {
        spendRows = await this.adSpend.getSpend(workspaceId, win.start, win.end);
      } catch (err) {
        this.logger.warn(`ad-spend provider falhou: ${(err as Error)?.message ?? err}`);
      }
      for (const r of spendRows) {
        spendByChannel.set(r.channel, (spendByChannel.get(r.channel) ?? 0) + r.spend);
        if (r.utmCampaign) {
          const k = `${r.channel} ${r.utmCampaign}`;
          spendByCampaign.set(k, (spendByCampaign.get(k) ?? 0) + r.spend);
        }
      }
    }

    const rows = Array.from(byCampaign.values())
      .map((c) => {
        const spend = spendAvailable
          ? spendByCampaign.get(`${c.channel} ${c.utmCampaign}`) ?? null
          : null;
        return {
          channel: c.channel,
          utm_source: c.utmSource,
          utm_medium: c.utmMedium,
          utm_campaign: c.utmCampaign,
          conversions: round(c.attributedConversions, 4),
          attributed_revenue: round(c.attributedRevenue, 2),
          spend: spend === null ? null : round(spend, 2),
          roas: spend === null ? null : round(safeDiv(c.attributedRevenue, spend), 4),
          cac: spend === null ? null : round(safeDiv(spend, c.attributedConversions), 4),
        };
      })
      .sort((a, b) => (b.attributed_revenue ?? 0) - (a.attributed_revenue ?? 0))
      .slice(0, limit);

    return {
      model: cfg.model,
      window_days: cfg.windowDays,
      channel: channelFilter ?? null,
      spend_available: spendAvailable,
      report_window: { start: win.start.toISOString(), end: win.end.toISOString() },
      // Conjunto/Anúncio (utm_content/utm_term) pendentes de projeção em touchpoints.
      hierarchy: ['channel', 'utm_source', 'utm_medium', 'utm_campaign'],
      rows,
    };
  }
}

// ───────────────────────────── helpers de módulo ─────────────────────────────

/** Soma de receita de todos os modelos de um canal (usado p/ ordenar o compare). */
function channelTotal(models: Record<string, { conversions: number; revenue: number }>): number {
  let sum = 0;
  for (const v of Object.values(models)) sum += v.revenue;
  return sum;
}

/** Colapsa canais idênticos consecutivos: [a,a,b,a] → [a,b,a]. */
function collapseConsecutive(seq: string[]): string[] {
  const out: string[] = [];
  for (const s of seq) {
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}
