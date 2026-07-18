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
 * Meta (Facebook/Instagram) Ads — Graph API (Marketing API).
 *
 * Insights por criativo/dia: GET /{version}/act_{accountId}/insights
 *   level=ad, time_increment=1, fields=spend,impressions,clicks,reach,actions,
 *   action_values + ids/nomes. As conversões/receita reportadas saem de `actions`/
 *   `action_values` (tipo 'omni_purchase'/'purchase').
 *
 * Credenciais (ENV, fail-closed):
 *   META_ADS_ACCESS_TOKEN   — access token (system user / long-lived) com ads_read.
 *   META_ADS_API_VERSION    — versão do Graph (default v21.0).
 *
 * // TODO(live): App Review (ads_read) + Business Verification (PRD §16, R3). O ToS
 * pode restringir armazenar spend/criativo (R4) — validar antes de ligar em prod.
 */
@Injectable()
export class MetaAdsClient implements AdsPlatformClient {
  readonly platform: CreativePlatform = 'meta';
  private readonly logger = new Logger(MetaAdsClient.name);

  private get token(): string {
    return process.env.META_ADS_ACCESS_TOKEN ?? '';
  }
  private get version(): string {
    return process.env.META_ADS_API_VERSION ?? 'v21.0';
  }

  isConfigured(): boolean {
    return this.token.trim() !== '';
  }

  /** Normaliza `123` ou `act_123` para `act_123`. */
  private actParam(accountId: string): string {
    return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
  }

  async fetchDailyInsights(
    workspaceId: string,
    accountId: string,
    startDay: string,
    endDay: string,
  ): Promise<CreativeDailyRow[]> {
    if (!this.isConfigured()) return [];
    const base = `https://graph.facebook.com/${this.version}/${this.actParam(accountId)}/insights`;
    const fields = [
      'ad_id',
      'ad_name',
      'campaign_id',
      'campaign_name',
      'adset_id',
      'adset_name',
      'spend',
      'impressions',
      'clicks',
      'reach',
      'account_currency',
      'actions',
      'action_values',
    ].join(',');
    const params = new URLSearchParams({
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since: startDay, until: endDay }),
      fields,
      limit: '500',
      access_token: this.token,
    });

    const out: CreativeDailyRow[] = [];
    let url: string | null = `${base}?${params.toString()}`;
    let guard = 0;
    try {
      while (url && guard < 200) {
        guard += 1;
        const res: Response = await fetchWithTimeout(url, { timeoutMs: 20_000 });
        if (!res.ok) {
          this.logger.warn(`Meta insights HTTP ${res.status} (account=${accountId})`);
          break;
        }
        const body = (await res.json()) as MetaInsightsResponse;
        for (const row of body.data ?? []) {
          out.push(this.toDailyRow(workspaceId, accountId, row));
        }
        url = body.paging?.next ?? null;
      }
    } catch (err) {
      this.logger.warn(`Meta insights falhou (account=${accountId}): ${errMsg(err)}`);
    }
    return out;
  }

  private toDailyRow(
    workspaceId: string,
    accountId: string,
    row: MetaInsightRow,
  ): CreativeDailyRow {
    const conversions = sumActionValue(row.actions, PURCHASE_ACTIONS);
    const revenue = sumActionValue(row.action_values, PURCHASE_ACTIONS);
    return {
      workspace_id: workspaceId,
      platform: 'meta',
      ad_id: str(row.ad_id),
      day: str(row.date_start),
      ad_account_id: this.actParam(accountId),
      campaign_id: str(row.campaign_id),
      campaign_name: str(row.campaign_name),
      adset_id: str(row.adset_id),
      ad_name: str(row.ad_name),
      creative_type: '', // preenchido pelo fetchCreatives (metadados)
      phase: inferPhase(str(row.campaign_name), str(row.adset_name)),
      currency: str(row.account_currency),
      spend: num(row.spend),
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      reach: num(row.reach),
      platform_conversions: conversions,
      platform_revenue: revenue,
    };
  }

  async fetchCreatives(accountId: string): Promise<CreativeMeta[]> {
    if (!this.isConfigured()) return [];
    const base = `https://graph.facebook.com/${this.version}/${this.actParam(accountId)}/ads`;
    const params = new URLSearchParams({
      fields:
        'id,name,status,effective_status,campaign_id,adset_id,creative{id,object_type,thumbnail_url,image_url,object_story_spec,link_url}',
      limit: '200',
      access_token: this.token,
    });
    const out: CreativeMeta[] = [];
    let url: string | null = `${base}?${params.toString()}`;
    let guard = 0;
    try {
      while (url && guard < 200) {
        guard += 1;
        const res: Response = await fetchWithTimeout(url, { timeoutMs: 20_000 });
        if (!res.ok) {
          this.logger.warn(`Meta ads HTTP ${res.status} (account=${accountId})`);
          break;
        }
        const body = (await res.json()) as MetaAdsResponse;
        for (const ad of body.data ?? []) {
          const creative = ad.creative ?? {};
          out.push({
            platform: 'meta',
            adId: str(ad.id),
            adName: str(ad.name),
            campaignId: str(ad.campaign_id),
            campaignName: '',
            adsetId: str(ad.adset_id),
            adsetName: '',
            creativeType: normalizeCreativeType(creative.object_type),
            phase: 'unknown',
            thumbnailUrl: str(creative.thumbnail_url || creative.image_url),
            previewUrl: str(creative.image_url),
            adStatus: str(ad.effective_status || ad.status),
            landingUrl: str(creative.link_url),
            raw: { creative_id: str(creative.id), object_type: str(creative.object_type) },
          });
        }
        url = body.paging?.next ?? null;
      }
    } catch (err) {
      this.logger.warn(`Meta ads falhou (account=${accountId}): ${errMsg(err)}`);
    }
    return out;
  }
}

// tipos de conversão de compra na Meta (omni cobre app + web + offline).
const PURCHASE_ACTIONS = new Set(['purchase', 'omni_purchase', 'offsite_conversion.fct_purchase']);

interface MetaActionEntry {
  action_type?: string;
  value?: string | number;
}
interface MetaInsightRow {
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  date_start?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  reach?: string | number;
  account_currency?: string;
  actions?: MetaActionEntry[];
  action_values?: MetaActionEntry[];
}
interface MetaInsightsResponse {
  data?: MetaInsightRow[];
  paging?: { next?: string };
}
interface MetaCreative {
  id?: string;
  object_type?: string;
  thumbnail_url?: string;
  image_url?: string;
  link_url?: string;
}
interface MetaAd {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  campaign_id?: string;
  adset_id?: string;
  creative?: MetaCreative;
}
interface MetaAdsResponse {
  data?: MetaAd[];
  paging?: { next?: string };
}

function sumActionValue(entries: MetaActionEntry[] | undefined, types: Set<string>): number {
  if (!entries) return 0;
  let acc = 0;
  for (const e of entries) {
    if (e.action_type && types.has(e.action_type)) acc += num(e.value);
  }
  return acc;
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
