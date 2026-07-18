/**
 * M10 — camada de leitura ClickHouse. Isola as queries dos services e dos
 * providers de DI (AD_SPEND / PLATFORM_METRICS). Toda query:
 *  · filtra workspace_id (regra 1);
 *  · o lado REAL vem de `creative_real_daily` (MV que já exclui bots — regra 11);
 *  · passa TODO valor de cliente por `query_params` (nunca interpola no SQL).
 */
import { getClickHouse } from './infra';
import {
  CH_CREATIVE_DAILY,
  CH_CREATIVE_REAL_DAILY,
  REVENUE_EVENTS,
  addDays,
  asNum,
  asStr,
  type DayRange,
} from './creatives.constants';

/** Filtros da listagem/leitura reportada (todos opcionais, já validados por zod). */
export interface ReportedFilters {
  platform?: string;
  campaignId?: string;
  creativeType?: string;
  phase?: string;
  adId?: string;
}

/** Uma linha do lado REPORTADO agregada por criativo na janela. */
export interface ReportedRow {
  platform: string;
  adId: string;
  adAccountId: string;
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adName: string;
  creativeType: string;
  phase: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  platformConversions: number;
  platformRevenue: number;
}

/** Uma linha do lado REAL (Truvo) agregada por criativo na janela. */
export interface RealRow {
  platform: string;
  adId: string; // = ad_ref
  landingViews: number;
  sessions: number;
  checkoutStarts: number;
  purchases: number;
  orders: number;
  realRevenue: number;
  refunds: number;
}

function buildReportedWhere(filters: ReportedFilters): string[] {
  const conds = [
    'workspace_id = {ws:String}',
    'day >= {start:Date}',
    'day <= {end:Date}',
  ];
  if (filters.platform) conds.push('platform = {platform:String}');
  if (filters.campaignId) conds.push('campaign_id = {campaign_id:String}');
  if (filters.creativeType) conds.push('creative_type = {creative_type:String}');
  if (filters.phase) conds.push('phase = {phase:String}');
  if (filters.adId) conds.push('ad_id = {ad_id:String}');
  return conds;
}

function reportedParams(workspaceId: string, range: DayRange, filters: ReportedFilters) {
  const params: Record<string, unknown> = {
    ws: workspaceId,
    start: range.startDay,
    end: range.endDay,
  };
  if (filters.platform) params.platform = filters.platform;
  if (filters.campaignId) params.campaign_id = filters.campaignId;
  if (filters.creativeType) params.creative_type = filters.creativeType;
  if (filters.phase) params.phase = filters.phase;
  if (filters.adId) params.ad_id = filters.adId;
  return params;
}

/** Lado REPORTADO agregado por (platform, ad_id) na janela. */
export async function queryReported(
  workspaceId: string,
  range: DayRange,
  filters: ReportedFilters = {},
): Promise<ReportedRow[]> {
  const where = buildReportedWhere(filters).join('\n          AND ');
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        platform,
        ad_id,
        argMax(ad_account_id, day) AS ad_account_id,
        argMax(campaign_id, day)   AS campaign_id,
        argMax(campaign_name, day) AS campaign_name,
        argMax(adset_id, day)      AS adset_id,
        argMax(ad_name, day)       AS ad_name,
        argMax(creative_type, day) AS creative_type,
        argMax(phase, day)         AS phase,
        argMax(currency, day)      AS currency,
        sum(spend)                 AS spend,
        sum(impressions)           AS impressions,
        sum(clicks)                AS clicks,
        sum(reach)                 AS reach,
        sum(platform_conversions)  AS platform_conversions,
        sum(platform_revenue)      AS platform_revenue
      FROM ${CH_CREATIVE_DAILY} FINAL
      WHERE ${where}
      GROUP BY platform, ad_id`,
    query_params: reportedParams(workspaceId, range, filters),
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    platform: asStr(r['platform']),
    adId: asStr(r['ad_id']),
    adAccountId: asStr(r['ad_account_id']),
    campaignId: asStr(r['campaign_id']),
    campaignName: asStr(r['campaign_name']),
    adsetId: asStr(r['adset_id']),
    adName: asStr(r['ad_name']),
    creativeType: asStr(r['creative_type']),
    phase: asStr(r['phase']),
    currency: asStr(r['currency']),
    spend: asNum(r['spend']),
    impressions: asNum(r['impressions']),
    clicks: asNum(r['clicks']),
    reach: asNum(r['reach']),
    platformConversions: asNum(r['platform_conversions']),
    platformRevenue: asNum(r['platform_revenue']),
  }));
}

/** Lado REAL (Truvo) agregado por (platform, ad_ref) na janela. */
export async function queryReal(
  workspaceId: string,
  range: DayRange,
  platform?: string,
  adId?: string,
): Promise<RealRow[]> {
  const conds = ['workspace_id = {ws:String}', 'day >= {start:Date}', 'day <= {end:Date}'];
  const params: Record<string, unknown> = { ws: workspaceId, start: range.startDay, end: range.endDay };
  if (platform) {
    conds.push('platform = {platform:String}');
    params.platform = platform;
  }
  if (adId) {
    conds.push('ad_ref = {ad_ref:String}');
    params.ad_ref = adId;
  }
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        platform,
        ad_ref                     AS ad_id,
        sum(landing_views)         AS landing_views,
        uniqMerge(sessions)        AS sessions,
        sum(checkout_starts)       AS checkout_starts,
        sum(purchases)             AS purchases,
        uniqMerge(orders)          AS orders,
        sum(real_revenue)          AS real_revenue,
        sum(refunds)               AS refunds
      FROM ${CH_CREATIVE_REAL_DAILY}
      WHERE ${conds.join('\n          AND ')}
      GROUP BY platform, ad_ref`,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    platform: asStr(r['platform']),
    adId: asStr(r['ad_id']),
    landingViews: asNum(r['landing_views']),
    sessions: asNum(r['sessions']),
    checkoutStarts: asNum(r['checkout_starts']),
    purchases: asNum(r['purchases']),
    orders: asNum(r['orders']),
    realRevenue: asNum(r['real_revenue']),
    refunds: asNum(r['refunds']),
  }));
}

/** Um ponto diário de série temporal (reportado + real) de UM criativo. */
export interface DailyPoint {
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  platformConversions: number;
  platformRevenue: number;
  sessions: number;
  checkoutStarts: number;
  purchases: number;
  orders: number;
  realRevenue: number;
  refunds: number;
}

/**
 * Série diária (reportado + real) por criativo na janela. Usada pelo detalhe
 * (gráfico temporal) e pelos alertas (fadiga/top sustentado). `platform`/`adId`
 * opcionais restringem a UM criativo; sem eles, retorna todos os criativos do
 * workspace (chave day+platform+ad_id) para a varredura de alertas.
 */
export interface DailyKeyedPoint extends DailyPoint {
  platform: string;
  adId: string;
}

export async function queryDailySeries(
  workspaceId: string,
  range: DayRange,
  platform?: string,
  adId?: string,
): Promise<DailyKeyedPoint[]> {
  // FULL OUTER JOIN entre os dois lados por (platform, ad_id, day): um criativo
  // pode ter spend sem conversão real (ou vice-versa) em um dia.
  const repConds = ['workspace_id = {ws:String}', 'day >= {start:Date}', 'day <= {end:Date}'];
  const realConds = ['workspace_id = {ws:String}', 'day >= {start:Date}', 'day <= {end:Date}'];
  const params: Record<string, unknown> = { ws: workspaceId, start: range.startDay, end: range.endDay };
  if (platform) {
    repConds.push('platform = {platform:String}');
    realConds.push('platform = {platform:String}');
    params.platform = platform;
  }
  if (adId) {
    repConds.push('ad_id = {ad_id:String}');
    realConds.push('ad_ref = {ad_id:String}');
    params.ad_id = adId;
  }
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        toString(if(rep.day != toDate(0), rep.day, rl.day))            AS day,
        if(rep.platform != '', rep.platform, rl.platform)              AS platform,
        if(rep.ad_id != '', rep.ad_id, rl.ad_id)                       AS ad_id,
        rep.spend                AS spend,
        rep.impressions          AS impressions,
        rep.clicks               AS clicks,
        rep.platform_conversions AS platform_conversions,
        rep.platform_revenue     AS platform_revenue,
        rl.sessions              AS sessions,
        rl.checkout_starts       AS checkout_starts,
        rl.purchases             AS purchases,
        rl.orders                AS orders,
        rl.real_revenue          AS real_revenue,
        rl.refunds               AS refunds
      FROM (
        SELECT platform, ad_id, day,
               sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
               sum(platform_conversions) AS platform_conversions, sum(platform_revenue) AS platform_revenue
        FROM ${CH_CREATIVE_DAILY} FINAL
        WHERE ${repConds.join(' AND ')}
        GROUP BY platform, ad_id, day
      ) AS rep
      FULL OUTER JOIN (
        SELECT platform, ad_ref AS ad_id, day,
               uniqMerge(sessions) AS sessions, sum(checkout_starts) AS checkout_starts,
               sum(purchases) AS purchases, uniqMerge(orders) AS orders,
               sum(real_revenue) AS real_revenue, sum(refunds) AS refunds
        FROM ${CH_CREATIVE_REAL_DAILY}
        WHERE ${realConds.join(' AND ')}
        GROUP BY platform, ad_ref, day
      ) AS rl
      ON rep.platform = rl.platform AND rep.ad_id = rl.ad_id AND rep.day = rl.day
      ORDER BY day`,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    day: asStr(r['day']),
    platform: asStr(r['platform']),
    adId: asStr(r['ad_id']),
    spend: asNum(r['spend']),
    impressions: asNum(r['impressions']),
    clicks: asNum(r['clicks']),
    platformConversions: asNum(r['platform_conversions']),
    platformRevenue: asNum(r['platform_revenue']),
    sessions: asNum(r['sessions']),
    checkoutStarts: asNum(r['checkout_starts']),
    purchases: asNum(r['purchases']),
    orders: asNum(r['orders']),
    realRevenue: asNum(r['real_revenue']),
    refunds: asNum(r['refunds']),
  }));
}

// ─────────── agregações p/ os providers de DI (M7 / M14) ───────────

/** Spend agregado por (platform, campaign) — base do AdSpendProvider (M7). */
export interface SpendByCampaignRow {
  platform: string;
  campaignName: string;
  spend: number;
  clicks: number;
  impressions: number;
}

export async function querySpendByCampaign(
  workspaceId: string,
  range: DayRange,
): Promise<SpendByCampaignRow[]> {
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        platform,
        campaign_name    AS campaign_name,
        sum(spend)       AS spend,
        sum(clicks)      AS clicks,
        sum(impressions) AS impressions
      FROM ${CH_CREATIVE_DAILY} FINAL
      WHERE workspace_id = {ws:String}
        AND day >= {start:Date}
        AND day <= {end:Date}
      GROUP BY platform, campaign_name`,
    query_params: { ws: workspaceId, start: range.startDay, end: range.endDay },
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    platform: asStr(r['platform']),
    campaignName: asStr(r['campaign_name']),
    spend: asNum(r['spend']),
    clicks: asNum(r['clicks']),
    impressions: asNum(r['impressions']),
  }));
}

/** Métrica reportada por (dia, platform) — base do PlatformMetricsProvider (M14). */
export interface ReportedDayRow {
  day: string;
  platform: string;
  adAccountId: string;
  platformConversions: number;
  platformRevenue: number;
  spend: number;
}

export async function queryReportedByDay(
  workspaceId: string,
  adAccount: string | undefined,
  range: DayRange,
): Promise<ReportedDayRow[]> {
  const conds = ['workspace_id = {ws:String}', 'day >= {start:Date}', 'day <= {end:Date}'];
  const params: Record<string, unknown> = { ws: workspaceId, start: range.startDay, end: range.endDay };
  if (adAccount) {
    conds.push('ad_account_id = {ad_account:String}');
    params.ad_account = adAccount;
  }
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        toString(day)              AS day,
        platform,
        argMax(ad_account_id, day) AS ad_account_id,
        sum(platform_conversions)  AS platform_conversions,
        sum(platform_revenue)      AS platform_revenue,
        sum(spend)                 AS spend
      FROM ${CH_CREATIVE_DAILY} FINAL
      WHERE ${conds.join('\n          AND ')}
      GROUP BY day, platform
      ORDER BY day, platform`,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    day: asStr(r['day']),
    platform: asStr(r['platform']),
    adAccountId: asStr(r['ad_account_id']),
    platformConversions: asNum(r['platform_conversions']),
    platformRevenue: asNum(r['platform_revenue']),
    spend: asNum(r['spend']),
  }));
}

/** Uma conversão real recente atribuída ao criativo (jornada dos compradores). */
export interface RecentConversion {
  orderId: string;
  ts: string;
  value: number;
  utmSource: string;
  utmCampaign: string;
}

/**
 * Compras reais recentes atribuídas a UM criativo (utm_content = ad_id), lidas
 * direto de `events` — SEMPRE workspace_id (regra 1) + is_bot = 0 (regra 11).
 * Dedup por order_id (a compra mais recente do pedido). Base da "jornada dos
 * compradores" no sheet de detalhe.
 */
export async function queryRecentConversions(
  workspaceId: string,
  adId: string,
  range: DayRange,
  limit: number,
): Promise<RecentConversion[]> {
  const ch = getClickHouse();
  const rs = await ch.query({
    query: `
      SELECT
        order_id                       AS order_id,
        toString(max(timestamp))       AS ts,
        argMax(value, timestamp)       AS value,
        argMax(utm_source, timestamp)  AS utm_source,
        argMax(utm_campaign, timestamp) AS utm_campaign
      FROM events
      WHERE workspace_id = {ws:String}
        AND is_bot = 0
        AND utm_content = {ad_ref:String}
        AND order_id != ''
        AND event_name IN {revenue_events:Array(String)}
        AND timestamp >= {start:DateTime64(3)}
        AND timestamp <  {end:DateTime64(3)}
      GROUP BY order_id
      ORDER BY ts DESC
      LIMIT {lim:UInt32}`,
    query_params: {
      ws: workspaceId,
      ad_ref: adId,
      revenue_events: [...REVENUE_EVENTS],
      start: `${range.startDay} 00:00:00.000`,
      end: `${addDays(range.endDay, 1)} 00:00:00.000`,
      lim: limit,
    },
    format: 'JSONEachRow',
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    orderId: asStr(r['order_id']),
    ts: asStr(r['ts']),
    value: asNum(r['value']),
    utmSource: asStr(r['utm_source']),
    utmCampaign: asStr(r['utm_campaign']),
  }));
}

/** Insere/reescreve linhas do lado reportado (ReplacingMergeTree). Usado pelo sync. */
export async function insertCreativeDaily(rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const ch = getClickHouse();
  await ch.insert({ table: CH_CREATIVE_DAILY, values: rows, format: 'JSONEachRow' });
}
