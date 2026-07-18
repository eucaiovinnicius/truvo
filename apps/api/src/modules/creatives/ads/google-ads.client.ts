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
 * Google Ads — REST API (googleAds:searchStream, GAQL).
 *
 * Insights por criativo/dia via `ad_group_ad` + `segments.date`. Custo vem em
 * micros (cost_micros / 1e6). Auth: OAuth2 (refresh token → access token) +
 * developer-token; contas de manager usam login-customer-id.
 *
 * Credenciais (ENV, fail-closed): GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
 * GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID
 * (opcional), GOOGLE_ADS_API_VERSION (default v17).
 *
 * // TODO(live): Developer Token basic→standard (PRD §16, R3). GAQL de datas usa
 * literais YYYY-MM-DD já normalizados por resolveDayRange (validados aqui de novo).
 */
@Injectable()
export class GoogleAdsClient implements AdsPlatformClient {
  readonly platform: CreativePlatform = 'google';
  private readonly logger = new Logger(GoogleAdsClient.name);

  private get developerToken(): string {
    return process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '';
  }
  private get clientId(): string {
    return process.env.GOOGLE_ADS_CLIENT_ID ?? '';
  }
  private get clientSecret(): string {
    return process.env.GOOGLE_ADS_CLIENT_SECRET ?? '';
  }
  private get refreshToken(): string {
    return process.env.GOOGLE_ADS_REFRESH_TOKEN ?? '';
  }
  private get loginCustomerId(): string {
    return (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '').replace(/-/g, '');
  }
  private get version(): string {
    return process.env.GOOGLE_ADS_API_VERSION ?? 'v17';
  }

  isConfigured(): boolean {
    return (
      this.developerToken.trim() !== '' &&
      this.clientId.trim() !== '' &&
      this.clientSecret.trim() !== '' &&
      this.refreshToken.trim() !== ''
    );
  }

  /** Troca o refresh token por um access token (OAuth2). null em falha. */
  private async getAccessToken(): Promise<string | null> {
    try {
      const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeoutMs: 15_000,
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
      if (!res.ok) {
        this.logger.warn(`Google OAuth HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { access_token?: string };
      return body.access_token ?? null;
    } catch (err) {
      this.logger.warn(`Google OAuth falhou: ${errMsg(err)}`);
      return null;
    }
  }

  private headers(accessToken: string): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'developer-token': this.developerToken,
      'content-type': 'application/json',
    };
    if (this.loginCustomerId) h['login-customer-id'] = this.loginCustomerId;
    return h;
  }

  async fetchDailyInsights(
    workspaceId: string,
    accountId: string,
    startDay: string,
    endDay: string,
  ): Promise<CreativeDailyRow[]> {
    if (!this.isConfigured()) return [];
    const customerId = digits(accountId);
    if (!customerId || !isDay(startDay) || !isDay(endDay)) return [];
    const accessToken = await this.getAccessToken();
    if (!accessToken) return [];

    const query =
      'SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ' +
      'campaign.id, campaign.name, ad_group.id, ad_group.name, ' +
      'metrics.cost_micros, metrics.impressions, metrics.clicks, ' +
      'metrics.conversions, metrics.conversions_value, segments.date ' +
      `FROM ad_group_ad WHERE segments.date BETWEEN '${startDay}' AND '${endDay}'`;

    const url = `https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`;
    const out: CreativeDailyRow[] = [];
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(accessToken),
        timeoutMs: 30_000,
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        this.logger.warn(`Google searchStream HTTP ${res.status} (customer=${customerId})`);
        return [];
      }
      // searchStream devolve um array de chunks { results: [...] }.
      const chunks = (await res.json()) as GoogleStreamChunk[];
      for (const chunk of Array.isArray(chunks) ? chunks : []) {
        for (const r of chunk.results ?? []) {
          out.push(this.toDailyRow(workspaceId, customerId, r));
        }
      }
    } catch (err) {
      this.logger.warn(`Google searchStream falhou (customer=${customerId}): ${errMsg(err)}`);
    }
    return out;
  }

  private toDailyRow(
    workspaceId: string,
    customerId: string,
    r: GoogleAdRow,
  ): CreativeDailyRow {
    const campaignName = str(r.campaign?.name);
    const adGroupName = str(r.adGroup?.name);
    return {
      workspace_id: workspaceId,
      platform: 'google',
      ad_id: str(r.adGroupAd?.ad?.id),
      day: str(r.segments?.date),
      ad_account_id: customerId,
      campaign_id: str(r.campaign?.id),
      campaign_name: campaignName,
      adset_id: str(r.adGroup?.id),
      ad_name: str(r.adGroupAd?.ad?.name),
      creative_type: normalizeCreativeType(r.adGroupAd?.ad?.type),
      phase: inferPhase(campaignName, adGroupName),
      currency: '', // customer.currency_code exigiria outro SELECT; deixamos vazio
      spend: num(r.metrics?.costMicros) / 1_000_000,
      impressions: num(r.metrics?.impressions),
      clicks: num(r.metrics?.clicks),
      reach: 0, // Google não expõe reach por ad neste recurso
      platform_conversions: num(r.metrics?.conversions),
      platform_revenue: num(r.metrics?.conversionsValue),
    };
  }

  async fetchCreatives(accountId: string): Promise<CreativeMeta[]> {
    if (!this.isConfigured()) return [];
    const customerId = digits(accountId);
    if (!customerId) return [];
    const accessToken = await this.getAccessToken();
    if (!accessToken) return [];

    const query =
      'SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ' +
      'ad_group_ad.status, ad_group_ad.ad.final_urls, campaign.id, campaign.name, ad_group.id ' +
      'FROM ad_group_ad';
    const url = `https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`;
    const out: CreativeMeta[] = [];
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(accessToken),
        timeoutMs: 30_000,
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        this.logger.warn(`Google ads meta HTTP ${res.status} (customer=${customerId})`);
        return [];
      }
      const chunks = (await res.json()) as GoogleStreamChunk[];
      for (const chunk of Array.isArray(chunks) ? chunks : []) {
        for (const r of chunk.results ?? []) {
          const finalUrls = r.adGroupAd?.ad?.finalUrls ?? [];
          out.push({
            platform: 'google',
            adId: str(r.adGroupAd?.ad?.id),
            adName: str(r.adGroupAd?.ad?.name),
            campaignId: str(r.campaign?.id),
            campaignName: str(r.campaign?.name),
            adsetId: str(r.adGroup?.id),
            adsetName: '',
            creativeType: normalizeCreativeType(r.adGroupAd?.ad?.type),
            phase: 'unknown',
            thumbnailUrl: '', // TODO(live): resolver asset image via AssetService
            previewUrl: '',
            adStatus: str(r.adGroupAd?.status),
            landingUrl: finalUrls[0] ? str(finalUrls[0]) : '',
            raw: { type: str(r.adGroupAd?.ad?.type) },
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Google ads meta falhou (customer=${customerId}): ${errMsg(err)}`);
    }
    return out;
  }
}

interface GoogleAdRow {
  adGroupAd?: {
    ad?: { id?: string; name?: string; type?: string; finalUrls?: string[] };
    status?: string;
  };
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: {
    costMicros?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversions?: string | number;
    conversionsValue?: string | number;
  };
}
interface GoogleStreamChunk {
  results?: GoogleAdRow[];
}

function digits(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}
function isDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
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
