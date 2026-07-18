import { Injectable, Logger } from '@nestjs/common';
import type { CreativePlatform } from '@truvo/db';
import type { AdSpendProvider, AdSpendRow } from '../../attribution/ad-spend.provider';
import { querySpendByCampaign } from '../creatives-ch';
import { AdsService } from '../ads/ads.service';
import { PLATFORM_TO_CHANNEL } from '../creatives.constants';

/**
 * M10 → M7. Implementação REAL do AD_SPEND_PROVIDER (interface de
 * attribution/ad-spend.provider.ts). Alimenta ROAS/CAC do campaign-breakdown do
 * M7 com o spend sincronizado das Ads APIs (ClickHouse `creative_daily`).
 *
 * WIRING (onda de integração — ver notes): o M7 hoje injeta o stub
 * `UnavailableAdSpendProvider`. Para religar sem tocar no service do M7, o
 * CreativesModule EXPORTA o token AD_SPEND_PROVIDER apontando para esta classe;
 * o AttributionModule passa a `imports: [CreativesModule]` e remove seu provider
 * local do token. Mesmo token (Symbol importado), mesma interface.
 *
 * Regra 12: sem plataforma configurada no ENV, `isAvailable()=false` e o M7 mantém
 * ROAS/CAC null (`spend_available=false`) — não inventamos spend.
 */
@Injectable()
export class CreativeAdSpendProvider implements AdSpendProvider {
  private readonly logger = new Logger(CreativeAdSpendProvider.name);

  constructor(private readonly ads: AdsService) {}

  isAvailable(): boolean {
    return this.ads.anyConfigured();
  }

  async getSpend(workspaceId: string, start: Date, end: Date): Promise<AdSpendRow[]> {
    const startDay = dayOf(start);
    // a janela do M7 é [start, end) exclusiva no fim → volta 1ms p/ o dia correto.
    const endDay = dayOf(new Date(Math.max(end.getTime() - 1, start.getTime())));
    const range = startDay <= endDay ? { startDay, endDay } : { startDay: endDay, endDay: startDay };

    try {
      const rows = await querySpendByCampaign(workspaceId, range);
      return rows.map((r) => ({
        channel: PLATFORM_TO_CHANNEL[r.platform as CreativePlatform] ?? 'paid_social',
        utmCampaign: r.campaignName || undefined,
        spend: r.spend,
        clicks: r.clicks,
        impressions: r.impressions,
      }));
    } catch (err) {
      this.logger.warn(`getSpend falhou (ws=${workspaceId}): ${errMsg(err)}`);
      return [];
    }
  }
}

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
