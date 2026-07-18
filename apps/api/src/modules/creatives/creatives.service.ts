import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { creatives, type Creative } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import {
  queryDailySeries,
  queryReal,
  queryRecentConversions,
  queryReported,
  type RealRow,
  type ReportedFilters,
  type ReportedRow,
} from './creatives-ch';
import {
  computeCreativeMetrics,
  joinAndCompute,
  type CreativeMetrics,
} from './creative-metrics';
import { resolveDayRange, round, type CreativeOrderBy } from './creatives.constants';

/** Item do grid: métrica + o "cartão" do criativo (thumbnail/status do cache). */
export interface CreativeGridItem extends CreativeMetrics {
  thumbnail_url: string;
  preview_url: string;
  ad_status: string;
  adset_name: string;
}

export interface CreativeGridResult {
  range: { start: string; end: string };
  filters: {
    platform: string | null;
    campaign_id: string | null;
    type: string | null;
    phase: string | null;
    order_by: CreativeOrderBy;
  };
  reported_available: boolean;
  totals: {
    creatives: number;
    spend: number;
    reported_revenue: number;
    real_revenue: number;
    real_conversions: number;
  };
  count: number;
  items: CreativeGridItem[];
}

/**
 * M10 — CREATIVE ANALYTICS (leitura). Cruza o REPORTADO pela plataforma
 * (creative_daily) com o REAL do Truvo (creative_real_daily / events) e expõe o
 * DELTA. Toda leitura escopada por workspace_id (regra 1); o lado real já exclui
 * bots (regra 11, via MV). Nunca inventa o lado ausente (regra 12).
 */
@Injectable()
export class CreativesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ─────────────────────────────── grid ───────────────────────────────

  async getGrid(
    workspaceId: string,
    dto: {
      platform?: string;
      campaign_id?: string;
      type?: string;
      phase?: string;
      order_by?: CreativeOrderBy;
      order_dir?: 'asc' | 'desc';
      start?: string;
      end?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<CreativeGridResult> {
    const range = resolveDayRange(dto.start, dto.end);
    const orderBy: CreativeOrderBy = dto.order_by ?? 'roas_real';
    const orderDir = dto.order_dir ?? 'desc';
    const limit = dto.limit ?? 50;
    const offset = dto.offset ?? 0;

    const filters: ReportedFilters = {
      platform: dto.platform,
      campaignId: dto.campaign_id,
      creativeType: dto.type,
      phase: dto.phase,
    };

    const [reported, real] = await Promise.all([
      queryReported(workspaceId, range, filters),
      queryReal(workspaceId, range, dto.platform),
    ]);

    let metrics = joinAndCompute(reported, real);

    // Filtros que só existem no cache/real (quando não há linha reportada, os dims
    // de campanha/tipo/fase vêm vazios) — reforça o filtro pós-join.
    if (dto.campaign_id) metrics = metrics.filter((m) => m.campaign_id === dto.campaign_id || !m.reported_available);
    if (dto.type) metrics = metrics.filter((m) => m.creative_type === dto.type || !m.reported_available);
    if (dto.phase) metrics = metrics.filter((m) => m.phase === dto.phase || !m.reported_available);

    // enriquece com o cache (thumbnail/status/adset). Puxa só os ad_ids em cena.
    const cache = await this.fetchCache(
      workspaceId,
      metrics.map((m) => ({ platform: m.platform, adId: m.ad_id })),
    );

    const items: CreativeGridItem[] = metrics.map((m) => {
      const c = cache.get(cacheKey(m.platform, m.ad_id));
      return {
        ...m,
        ad_name: m.ad_name || (c?.adName ?? ''),
        campaign_name: m.campaign_name || (c?.campaignName ?? ''),
        creative_type: m.creative_type || (c?.creativeType ?? ''),
        phase: m.phase || (c?.phase ?? ''),
        thumbnail_url: c?.thumbnailUrl ?? '',
        preview_url: c?.previewUrl ?? '',
        ad_status: c?.adStatus ?? '',
        adset_name: c?.adsetName ?? '',
      };
    });

    sortByMetric(items, orderBy, orderDir);

    const totals = items.reduce(
      (acc, m) => {
        acc.spend += m.reported.spend;
        acc.reported_revenue += m.reported.revenue;
        acc.real_revenue += m.real.revenue;
        acc.real_conversions += m.real.conversions;
        return acc;
      },
      { spend: 0, reported_revenue: 0, real_revenue: 0, real_conversions: 0 },
    );

    return {
      range: { start: range.startDay, end: range.endDay },
      filters: {
        platform: dto.platform ?? null,
        campaign_id: dto.campaign_id ?? null,
        type: dto.type ?? null,
        phase: dto.phase ?? null,
        order_by: orderBy,
      },
      reported_available: reported.length > 0,
      totals: {
        creatives: items.length,
        spend: round(totals.spend, 2) ?? 0,
        reported_revenue: round(totals.reported_revenue, 2) ?? 0,
        real_revenue: round(totals.real_revenue, 2) ?? 0,
        real_conversions: round(totals.real_conversions, 2) ?? 0,
      },
      count: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  // ────────────────────────────── detalhe ──────────────────────────────

  /**
   * Sheet de detalhe de UM criativo: métricas + funil + série temporal + jornada
   * dos compradores. `platform` opcional desambigua quando o mesmo ad_id existe em
   * mais de uma plataforma (raro) — sem ele, usa a 1ª correspondência.
   */
  async getDetail(
    workspaceId: string,
    adId: string,
    dto: { platform?: string; start?: string; end?: string; buyers_limit?: number },
  ) {
    const range = resolveDayRange(dto.start, dto.end);

    const [reportedAll, realAll] = await Promise.all([
      queryReported(workspaceId, range, { adId, platform: dto.platform }),
      queryReal(workspaceId, range, dto.platform, adId),
    ]);

    const platform = dto.platform ?? reportedAll[0]?.platform ?? realAll[0]?.platform;
    const reported: ReportedRow | null =
      reportedAll.find((r) => r.platform === platform) ?? reportedAll[0] ?? null;
    const real: RealRow | null = realAll.find((r) => r.platform === platform) ?? realAll[0] ?? null;

    if (!reported && !real) {
      return {
        found: false as const,
        ad_id: adId,
        range: { start: range.startDay, end: range.endDay },
      };
    }

    const metrics = computeCreativeMetrics(reported, real);
    const resolvedPlatform = metrics.platform;

    const [cacheRow, series, buyers] = await Promise.all([
      this.fetchOne(workspaceId, resolvedPlatform, adId),
      queryDailySeries(workspaceId, range, resolvedPlatform, adId),
      queryRecentConversions(workspaceId, adId, range, Math.min(dto.buyers_limit ?? 25, 100)),
    ]);

    const timeseries = series.map((p) => ({
      day: p.day,
      spend: round(p.spend, 2),
      impressions: p.impressions,
      clicks: p.clicks,
      reported_conversions: round(p.platformConversions, 2),
      reported_revenue: round(p.platformRevenue, 2),
      sessions: p.sessions,
      checkouts: p.checkoutStarts,
      real_conversions: p.orders,
      real_revenue: round(p.realRevenue - p.refunds, 2),
    }));

    return {
      found: true as const,
      range: { start: range.startDay, end: range.endDay },
      creative: {
        ...metrics,
        ad_name: metrics.ad_name || (cacheRow?.adName ?? ''),
        thumbnail_url: cacheRow?.thumbnailUrl ?? '',
        preview_url: cacheRow?.previewUrl ?? '',
        ad_status: cacheRow?.adStatus ?? '',
        landing_url: cacheRow?.landingUrl ?? '',
        adset_name: metrics.adset_id ? cacheRow?.adsetName ?? '' : '',
      },
      timeseries,
      buyers_journey: buyers.map((b) => ({
        order_id: b.orderId,
        converted_at: b.ts,
        value: round(b.value, 2),
        utm_source: b.utmSource,
        utm_campaign: b.utmCampaign,
      })),
    };
  }

  // ────────────────────────────── compare ──────────────────────────────

  /** Comparação de 2–4 criativos: side-by-side + insight automático. */
  async compare(
    workspaceId: string,
    adIds: string[],
    dto: { platform?: string; start?: string; end?: string },
  ) {
    const range = resolveDayRange(dto.start, dto.end);

    const [reported, real] = await Promise.all([
      queryReported(workspaceId, range, { platform: dto.platform }),
      queryReal(workspaceId, range, dto.platform),
    ]);

    const wanted = new Set(adIds);
    const repByAd = new Map<string, ReportedRow>();
    for (const r of reported) if (wanted.has(r.adId)) repByAd.set(r.adId, r);
    const realByAd = new Map<string, RealRow>();
    for (const r of real) if (wanted.has(r.adId)) realByAd.set(r.adId, r);

    const cache = await this.fetchCache(
      workspaceId,
      adIds.map((adId) => ({ platform: dto.platform ?? '', adId })),
      true,
    );

    const items = adIds.map((adId) => {
      const rep = repByAd.get(adId) ?? null;
      const rl = realByAd.get(adId) ?? null;
      const m = computeCreativeMetrics(rep, rl);
      const c = cache.get(cacheKey(m.platform, adId)) ?? cache.get(cacheKey('', adId));
      return {
        ...m,
        ad_id: adId,
        platform: m.platform || (c?.platform ?? ''),
        found: rep !== null || rl !== null,
        ad_name: m.ad_name || (c?.adName ?? ''),
        thumbnail_url: c?.thumbnailUrl ?? '',
      };
    });

    return {
      range: { start: range.startDay, end: range.endDay },
      count: items.length,
      items,
      insight: buildCompareInsight(items),
    };
  }

  // ───────────────────────────── scorecard ─────────────────────────────

  /**
   * Scorecard de UM criativo (dados p/ exportar em PNG/PDF/link — a renderização é
   * client-side no M13/relatórios; aqui devolvemos o payload estruturado + verdict).
   */
  async scorecard(
    workspaceId: string,
    adId: string,
    dto: { platform?: string; start?: string; end?: string },
  ) {
    const detail = await this.getDetail(workspaceId, adId, { ...dto, buyers_limit: 0 });
    if (!detail.found) {
      return { found: false as const, ad_id: adId, range: detail.range };
    }
    const m = detail.creative;
    const verdictLabel = verdictText(m.delta.verdict, m.delta.percent);
    return {
      found: true as const,
      range: detail.range,
      creative: {
        platform: m.platform,
        ad_id: m.ad_id,
        ad_name: m.ad_name,
        campaign_name: m.campaign_name,
        creative_type: m.creative_type,
        phase: m.phase,
        thumbnail_url: m.thumbnail_url,
      },
      headline: {
        roas_reported: m.reported.roas,
        roas_real: m.real.roas,
        delta_roas: m.delta.roas,
        delta_percent: m.delta.percent,
        verdict: m.delta.verdict,
        verdict_label: verdictLabel,
      },
      reported: m.reported,
      real: m.real,
      funnel: m.funnel,
      // TODO(live): gerar link/PNG/PDF pelo M13 (Relatórios); aqui só o payload.
      export: { formats: ['png', 'pdf', 'link'], rendered: false },
    };
  }

  // ─────────────────────────── cache (Postgres) ───────────────────────────

  private async fetchOne(
    workspaceId: string,
    platform: string,
    adId: string,
  ): Promise<Creative | undefined> {
    const rows = await this.db
      .select()
      .from(creatives)
      .where(
        and(
          eq(creatives.workspaceId, workspaceId),
          eq(creatives.platform, platform as Creative['platform']),
          eq(creatives.adId, adId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Busca o cache de metadados p/ um conjunto de (platform, adId). `ignorePlatform`
   * casa só por adId (usado no compare, onde a plataforma pode não vir no request).
   */
  private async fetchCache(
    workspaceId: string,
    keys: Array<{ platform: string; adId: string }>,
    ignorePlatform = false,
  ): Promise<Map<string, Creative>> {
    const map = new Map<string, Creative>();
    const adIds = Array.from(new Set(keys.map((k) => k.adId).filter(Boolean)));
    if (adIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(creatives)
      .where(and(eq(creatives.workspaceId, workspaceId), inArray(creatives.adId, adIds)));
    for (const r of rows) {
      map.set(cacheKey(r.platform, r.adId), r);
      if (ignorePlatform) map.set(cacheKey('', r.adId), r);
    }
    return map;
  }
}

// ───────────────────────────── helpers de módulo ─────────────────────────────

function cacheKey(platform: string, adId: string): string {
  return `${platform}|${adId}`;
}

/** Valor numérico de ordenação p/ um item (null vai para o fim). */
function metricValue(m: CreativeMetrics, key: CreativeOrderBy): number | null {
  switch (key) {
    case 'roas_real':
      return m.real.roas;
    case 'revenue_real':
      return m.real.revenue;
    case 'conversions_real':
      return m.real.conversions;
    case 'spend':
      return m.reported.spend;
    case 'delta_roas':
      return m.delta.roas;
    case 'delta_percent':
      return m.delta.percent;
    case 'ctr':
      return m.reported.ctr;
    case 'roas_reported':
      return m.reported.roas;
    case 'impressions':
      return m.reported.impressions;
    case 'clicks':
      return m.reported.clicks;
    default:
      return null;
  }
}

function sortByMetric(
  items: CreativeMetrics[],
  key: CreativeOrderBy,
  dir: 'asc' | 'desc',
): void {
  const mul = dir === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    const av = metricValue(a, key);
    const bv = metricValue(b, key);
    // nulls sempre por último, independente da direção.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * mul;
  });
}

/** Insight automático da comparação: melhor ROAS real + maior superestimação. */
function buildCompareInsight(
  items: Array<CreativeMetrics & { ad_name: string }>,
): { best_real_roas: string | null; most_overstated: string | null; summary: string } {
  let best: (CreativeMetrics & { ad_name: string }) | null = null;
  let overstated: (CreativeMetrics & { ad_name: string }) | null = null;
  for (const it of items) {
    if (it.real.roas !== null && (best === null || (best.real.roas ?? -Infinity) < it.real.roas)) {
      best = it;
    }
    if (
      it.delta.percent !== null &&
      (overstated === null || (overstated.delta.percent ?? -Infinity) < it.delta.percent)
    ) {
      overstated = it;
    }
  }
  const label = (x: { ad_name: string; ad_id: string } | null) =>
    x ? x.ad_name || x.ad_id : null;
  const parts: string[] = [];
  if (best && best.real.roas !== null) {
    parts.push(`${label(best)} tem o melhor ROAS real (${best.real.roas}x).`);
  }
  if (overstated && overstated.delta.percent !== null && overstated.delta.percent > 0) {
    parts.push(
      `${label(overstated)} é o mais superestimado pela plataforma (+${Math.round(
        overstated.delta.percent * 100,
      )}%).`,
    );
  }
  return {
    best_real_roas: label(best),
    most_overstated: label(overstated),
    summary: parts.join(' ') || 'Sem dados suficientes para comparar.',
  };
}

/** Texto humano do verdict (usado no scorecard). */
function verdictText(verdict: string, percent: number | null): string {
  const pct = percent === null ? null : Math.round(percent * 100);
  switch (verdict) {
    case 'overstated':
      return pct === null
        ? 'A plataforma superestima o resultado deste criativo.'
        : `A plataforma superestima este criativo em ${pct}%.`;
    case 'understated':
      return pct === null
        ? 'A plataforma subestima o resultado deste criativo.'
        : `A plataforma subestima este criativo em ${Math.abs(pct)}%.`;
    case 'aligned':
      return 'Plataforma e Truvo estão alinhados neste criativo.';
    default:
      return 'Sem base para comparar (falta spend reportado ou conversão real).';
  }
}
