import { Injectable, Logger } from '@nestjs/common';
import type { CreativePlatform } from '@truvo/db';
import type {
  PlatformDailyMetric,
  PlatformMetricsProvider,
} from '../../data-quality/platform-metrics';
import { queryReportedByDay } from '../creatives-ch';
import { AdsService } from '../ads/ads.service';
import { PLATFORM_TO_SOURCE } from '../creatives.constants';

/**
 * M10 → M14. Implementação REAL do PLATFORM_METRICS_PROVIDER (interface de
 * data-quality/platform-metrics.ts). Dá ao monitor de discrepância do M14 o LADO
 * PLATAFORMA (conversões/receita reportadas por dia/canal), lido do ClickHouse
 * `creative_daily`. O M14 compara com o lado Truvo reconciliado e marca `spike`.
 *
 * O eixo de junção do M14 é `channel` = utm_source (ex.: 'facebook','google').
 * Mapeamos platform → source canônica (PLATFORM_TO_SOURCE). // TODO(live): quando
 * o M10 resolver ad_account por click_id, expor `adAccount` real p/ o filtro.
 *
 * WIRING (ver notes): CreativesModule exporta o token PLATFORM_METRICS_PROVIDER
 * apontando para esta classe; o DataQualityModule passa a `imports: [CreativesModule]`
 * e remove o stub local. Mesmo token, mesma interface.
 *
 * Regra 12/14: sem plataforma configurada, `isAvailable()=false` → o M14 reporta só
 * o lado Truvo (`platform_available=false`). Não inventamos o número da plataforma.
 */
@Injectable()
export class CreativePlatformMetricsProvider implements PlatformMetricsProvider {
  private readonly logger = new Logger(CreativePlatformMetricsProvider.name);

  constructor(private readonly ads: AdsService) {}

  isAvailable(): boolean {
    return this.ads.anyConfigured();
  }

  async getDailyMetrics(
    workspaceId: string,
    adAccount: string | undefined,
    startDay: string,
    endDay: string,
  ): Promise<PlatformDailyMetric[]> {
    const range = startDay <= endDay ? { startDay, endDay } : { startDay: endDay, endDay: startDay };
    try {
      const rows = await queryReportedByDay(workspaceId, adAccount, range);
      return rows.map((r) => ({
        day: r.day,
        adAccount: r.adAccountId,
        channel: PLATFORM_TO_SOURCE[r.platform as CreativePlatform] ?? r.platform,
        platformConversions: r.platformConversions,
        platformRevenue: r.platformRevenue,
        spend: r.spend,
      }));
    } catch (err) {
      this.logger.warn(`getDailyMetrics falhou (ws=${workspaceId}): ${errMsg(err)}`);
      return [];
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
