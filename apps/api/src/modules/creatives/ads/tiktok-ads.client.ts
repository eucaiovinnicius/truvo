import { Injectable, Logger } from '@nestjs/common';
import type { CreativePlatform } from '@truvo/db';
import {
  fetchWithTimeout,
  inferPhase,
  normalizeCreativeType,
  type AdsPlatformClient,
  type CreativeDailyRow,
  type CreativeMeta,
} from './types';

/**
 * TikTok — Marketing API (report/integrated). Insights por ad_id/dia com métricas
 * BASIC no data_level AUCTION_AD.
 *
 * Credenciais (ENV, fail-closed): TIKTOK_ADS_ACCESS_TOKEN, TIKTOK_ADS_API_VERSION
 * (default v1.3). `accountId` = advertiser_id.
 *
 * // TODO(live): Marketing API access (PRD §16, R3). Nome da métrica de receita
 * varia por conta (total_complete_payment_value / total_onsite_shopping_value) —
 * parse defensivo cobre as duas.
 */
@Injectable()
export class TikTokAdsClient implements AdsPlatformClient {
  readonly platform: CreativePlatform = 'tiktok';
  private readonly logger = new Logger(TikTokAdsClient.name);

  private get token(): string {
    return process.env.TIKTOK_ADS_ACCESS_TOKEN ?? '';
  }
  private get version(): string {
    return process.env.TIKTOK_ADS_API_VERSION ?? 'v1.3';
  }
  private get baseUrl(): string {
    return `https://business-api.tiktok.com/open_api/${this.version}`;
  }

  isConfigured(): boolean {
    return this.token.trim() !== '';
  }

  private headers(): Record<string, string> {
    return { 'Access-Token': this.token, 'content-type': 'application/json' };
  }

  async fetchDailyInsights(
    workspaceId: string,
    accountId: string,
    startDay: string,
    endDay: string,
  ): Promise<CreativeDailyRow[]> {
    if (!this.isConfigured()) return [];
    const metrics = [
      'ad_name',
      'campaign_id',
      'campaign_name',
      'adgroup_id',
      'adgroup_name',
      'spend',
      'impressions',
      'clicks',
      'reach',
      'conversion',
      'complete_payment',
      'total_complete_payment_value',
      'total_onsite_shopping_value',
    ];

    const out: CreativeDailyRow[] = [];
    let page = 1;
    let totalPages = 1;
    let guard = 0;
    try {
      do {
        guard += 1;
        const params = new URLSearchParams({
          advertiser_id: accountId,
          report_type: 'BASIC',
          data_level: 'AUCTION_AD',
          dimensions: JSON.stringify(['ad_id', 'stat_time_day']),
          metrics: JSON.stringify(metrics),
          start_date: startDay,
          end_date: endDay,
          page: String(page),
          page_size: '200',
        });
        const url = `${this.baseUrl}/report/integrated/get/?${params.toString()}`;
        const res = await fetchWithTimeout(url, { headers: this.headers(), timeoutMs: 25_000 });
        if (!res.ok) {
          this.logger.warn(`TikTok report HTTP ${res.status} (advertiser=${accountId})`);
          break;
        }
        const body = (await res.json()) as TikTokReportResponse;
        if (body.code !== 0) {
          this.logger.warn(`TikTok report code ${body.code}: ${str(body.message)}`);
          break;
        }
        for (const row of body.data?.list ?? []) {
          out.push(this.toDailyRow(workspaceId, accountId, row));
        }
        totalPages = num(body.data?.page_info?.total_page) || 1;
        page += 1;
      } while (page <= totalPages && guard < 200);
    } catch (err) {
      this.logger.warn(`TikTok report falhou (advertiser=${accountId}): ${errMsg(err)}`);
    }
    return out;
  }

  private toDailyRow(
    workspaceId: string,
    accountId: string,
    row: TikTokReportRow,
  ): CreativeDailyRow {
    const dims = row.dimensions ?? {};
    const m = row.metrics ?? {};
    const revenue =
      num(m.total_complete_payment_value) ||
      num(m.total_onsite_shopping_value) ||
      0;
    const conversions = num(m.conversion) || num(m.complete_payment) || 0;
    const campaignName = str(m.campaign_name);
    const adgroupName = str(m.adgroup_name);
    return {
      workspace_id: workspaceId,
      platform: 'tiktok',
      ad_id: str(dims.ad_id),
      day: str(dims.stat_time_day).slice(0, 10),
      ad_account_id: accountId,
      campaign_id: str(m.campaign_id),
      campaign_name: campaignName,
      adset_id: str(m.adgroup_id),
      ad_name: str(m.ad_name),
      creative_type: 'video', // TikTok é vídeo-first; refinado pelo fetchCreatives
      phase: inferPhase(campaignName, adgroupName),
      currency: '',
      spend: num(m.spend),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      reach: num(m.reach),
      platform_conversions: conversions,
      platform_revenue: revenue,
    };
  }

  async fetchCreatives(accountId: string): Promise<CreativeMeta[]> {
    if (!this.isConfigured()) return [];
    const out: CreativeMeta[] = [];
    let page = 1;
    let totalPages = 1;
    let guard = 0;
    try {
      do {
        guard += 1;
        const params = new URLSearchParams({
          advertiser_id: accountId,
          fields: JSON.stringify([
            'ad_id',
            'ad_name',
            'campaign_id',
            'adgroup_id',
            'operation_status',
            'image_ids',
            'video_id',
            'landing_page_url',
          ]),
          page: String(page),
          page_size: '100',
        });
        const url = `${this.baseUrl}/ad/get/?${params.toString()}`;
        const res = await fetchWithTimeout(url, { headers: this.headers(), timeoutMs: 25_000 });
        if (!res.ok) {
          this.logger.warn(`TikTok ad/get HTTP ${res.status} (advertiser=${accountId})`);
          break;
        }
        const body = (await res.json()) as TikTokAdListResponse;
        if (body.code !== 0) {
          this.logger.warn(`TikTok ad/get code ${body.code}: ${str(body.message)}`);
          break;
        }
        for (const ad of body.data?.list ?? []) {
          out.push({
            platform: 'tiktok',
            adId: str(ad.ad_id),
            adName: str(ad.ad_name),
            campaignId: str(ad.campaign_id),
            campaignName: '',
            adsetId: str(ad.adgroup_id),
            adsetName: '',
            creativeType: normalizeCreativeType(ad.video_id ? 'video' : 'image'),
            phase: 'unknown',
            thumbnailUrl: '', // TODO(live): resolver via /file/image/ad/info/ (image_ids)
            previewUrl: '',
            adStatus: str(ad.operation_status),
            landingUrl: str(ad.landing_page_url),
            raw: { video_id: str(ad.video_id) },
          });
        }
        totalPages = num(body.data?.page_info?.total_page) || 1;
        page += 1;
      } while (page <= totalPages && guard < 200);
    } catch (err) {
      this.logger.warn(`TikTok ad/get falhou (advertiser=${accountId}): ${errMsg(err)}`);
    }
    return out;
  }
}

interface TikTokReportRow {
  dimensions?: { ad_id?: string; stat_time_day?: string };
  metrics?: Record<string, string | number | undefined>;
}
interface TikTokReportResponse {
  code?: number;
  message?: string;
  data?: { list?: TikTokReportRow[]; page_info?: { total_page?: number } };
}
interface TikTokAd {
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  adgroup_id?: string;
  operation_status?: string;
  video_id?: string;
  image_ids?: string[];
  landing_page_url?: string;
}
interface TikTokAdListResponse {
  code?: number;
  message?: string;
  data?: { list?: TikTokAd[]; page_info?: { total_page?: number } };
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
