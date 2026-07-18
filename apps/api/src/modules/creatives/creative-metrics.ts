/**
 * M10 — cálculo puro das métricas do criativo: REPORTADO vs REAL e o DELTA.
 * Sem I/O — recebe as linhas já lidas do ClickHouse e devolve o objeto de métrica
 * (usado pelo grid, detalhe, compare e scorecard). Divisões protegidas (safeDiv):
 * sem denominador → null, nunca Infinity/NaN (regra 12: não inventar número).
 */
import { ALERT_THRESHOLDS, round, safeDiv } from './creatives.constants';
import type { ReportedRow, RealRow } from './creatives-ch';

/** Métricas reportadas pela plataforma (o que a Ads API diz). */
export interface ReportedMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  ctr: number | null; // clicks / impressions
  conversions: number;
  revenue: number;
  roas: number | null; // revenue / spend
  cac: number | null; // spend / conversions
}

/** Métricas reais medidas pelo Truvo (server-side, is_bot = 0). */
export interface RealMetrics {
  conversions: number; // orders distintos (dedup)
  revenue: number; // receita líquida (compras - estornos)
  sessions: number;
  checkouts: number;
  roas: number | null; // revenue / spend
  cac: number | null; // spend / conversions
  cvr: number | null; // conversions / clicks (plataforma)
}

/** O DELTA — o insight central do M10. */
export interface DeltaMetrics {
  roas: number | null; // reported.roas - real.roas
  percent: number | null; // (reported.roas - real.roas) / real.roas
  revenue: number | null; // reported.revenue - real.revenue
  conversions: number | null; // reported.conversions - real.conversions
  /** 'overstated' = plataforma superestima; 'understated' = subestima; 'aligned'. */
  verdict: 'overstated' | 'understated' | 'aligned' | 'unknown';
}

/** Funil do criativo: cliques → sessões → checkouts → compras. */
export interface CreativeFunnel {
  clicks: number; // lado plataforma
  sessions: number;
  checkouts: number;
  purchases: number;
  rates: {
    click_to_session: number | null;
    session_to_checkout: number | null;
    checkout_to_purchase: number | null;
    click_to_purchase: number | null;
  };
}

export interface CreativeMetrics {
  platform: string;
  ad_id: string;
  ad_name: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  creative_type: string;
  phase: string;
  currency: string;
  reported: ReportedMetrics;
  real: RealMetrics;
  delta: DeltaMetrics;
  funnel: CreativeFunnel;
  /** true quando há dados reportados (creative_daily) para o criativo. */
  reported_available: boolean;
  /** true quando há sinal real do Truvo (sessões/compras) para o criativo. */
  real_available: boolean;
}

const EMPTY_REAL: RealRow = {
  platform: '',
  adId: '',
  landingViews: 0,
  sessions: 0,
  checkoutStarts: 0,
  purchases: 0,
  orders: 0,
  realRevenue: 0,
  refunds: 0,
};

function verdictOf(reportedRoas: number | null, realRoas: number | null): DeltaMetrics['verdict'] {
  if (reportedRoas === null || realRoas === null) return 'unknown';
  const rel = safeDiv(reportedRoas - realRoas, realRoas);
  if (rel === null) return 'unknown';
  if (rel > ALERT_THRESHOLDS.discrepancyDeltaPct) return 'overstated';
  if (rel < -ALERT_THRESHOLDS.discrepancyDeltaPct) return 'understated';
  return 'aligned';
}

/**
 * Combina o lado reportado e o real de UM criativo. `reported` pode ser null
 * (criativo com conversão real mas sem sync de spend) e `real` pode faltar
 * (spend sem conversão real). Nunca inventamos o lado ausente.
 */
export function computeCreativeMetrics(
  reported: ReportedRow | null,
  real: RealRow | null,
): CreativeMetrics {
  const rep = reported;
  const rl = real ?? EMPTY_REAL;
  const reportedAvailable = rep !== null;
  const realAvailable = real !== null;

  const spend = rep?.spend ?? 0;
  const impressions = rep?.impressions ?? 0;
  const clicks = rep?.clicks ?? 0;
  const reportedConversions = rep?.platformConversions ?? 0;
  const reportedRevenue = rep?.platformRevenue ?? 0;

  const realRevenueNet = rl.realRevenue - rl.refunds;
  const realConversions = rl.orders;

  const reportedRoas = reportedAvailable ? safeDiv(reportedRevenue, spend) : null;
  const realRoas = reportedAvailable ? safeDiv(realRevenueNet, spend) : null; // ROAS real precisa do spend da plataforma

  const platform = rep?.platform ?? rl.platform;
  const adId = rep?.adId ?? rl.adId;

  const delta: DeltaMetrics = {
    roas:
      reportedRoas !== null && realRoas !== null ? round(reportedRoas - realRoas, 4) : null,
    percent:
      reportedRoas !== null && realRoas !== null
        ? round(safeDiv(reportedRoas - realRoas, realRoas), 4)
        : null,
    revenue: reportedAvailable ? round(reportedRevenue - realRevenueNet, 2) : null,
    conversions: reportedAvailable ? round(reportedConversions - realConversions, 2) : null,
    verdict: verdictOf(reportedRoas, realRoas),
  };

  const funnel: CreativeFunnel = {
    clicks,
    sessions: rl.sessions,
    checkouts: rl.checkoutStarts,
    purchases: rl.purchases,
    rates: {
      click_to_session: round(safeDiv(rl.sessions, clicks), 4),
      session_to_checkout: round(safeDiv(rl.checkoutStarts, rl.sessions), 4),
      checkout_to_purchase: round(safeDiv(rl.purchases, rl.checkoutStarts), 4),
      click_to_purchase: round(safeDiv(rl.purchases, clicks), 4),
    },
  };

  return {
    platform,
    ad_id: adId,
    ad_name: rep?.adName ?? '',
    campaign_id: rep?.campaignId ?? '',
    campaign_name: rep?.campaignName ?? '',
    adset_id: rep?.adsetId ?? '',
    creative_type: rep?.creativeType ?? '',
    phase: rep?.phase ?? '',
    currency: rep?.currency ?? '',
    reported_available: reportedAvailable,
    real_available: realAvailable,
    reported: {
      spend: round(spend, 2) ?? 0,
      impressions,
      clicks,
      reach: rep?.reach ?? 0,
      ctr: round(safeDiv(clicks, impressions), 4),
      conversions: round(reportedConversions, 2) ?? 0,
      revenue: round(reportedRevenue, 2) ?? 0,
      roas: round(reportedRoas, 4),
      cac: reportedAvailable ? round(safeDiv(spend, reportedConversions), 2) : null,
    },
    real: {
      conversions: realConversions,
      revenue: round(realRevenueNet, 2) ?? 0,
      sessions: rl.sessions,
      checkouts: rl.checkoutStarts,
      roas: round(realRoas, 4),
      cac: reportedAvailable ? round(safeDiv(spend, realConversions), 2) : null,
      cvr: round(safeDiv(realConversions, clicks), 4),
    },
    delta,
    funnel,
  };
}

/** Junta as linhas reportadas + reais por (platform, ad_id) e computa as métricas. */
export function joinAndCompute(reported: ReportedRow[], real: RealRow[]): CreativeMetrics[] {
  const key = (p: string, a: string) => `${p}|${a}`;
  const realMap = new Map<string, RealRow>();
  for (const r of real) realMap.set(key(r.platform, r.adId), r);

  const out: CreativeMetrics[] = [];
  const seen = new Set<string>();
  for (const rep of reported) {
    const k = key(rep.platform, rep.adId);
    seen.add(k);
    out.push(computeCreativeMetrics(rep, realMap.get(k) ?? null));
  }
  // Criativos com conversão real mas sem linha reportada (spend não sincronizado):
  // aparecem só com o lado real (delta = null — honesto).
  for (const r of real) {
    const k = key(r.platform, r.adId);
    if (seen.has(k)) continue;
    out.push(computeCreativeMetrics(null, r));
  }
  return out;
}
