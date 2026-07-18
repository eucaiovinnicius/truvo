import { Module } from '@nestjs/common';
import { AD_SPEND_PROVIDER } from '../attribution/ad-spend.provider';
import { PLATFORM_METRICS_PROVIDER } from '../data-quality/platform-metrics';
import { CreativesController } from './creatives.controller';
import { CreativesService } from './creatives.service';
import { CreativeAlertsService } from './creative-alerts.service';
import { AdsService } from './ads/ads.service';
import { MetaAdsClient } from './ads/meta-ads.client';
import { GoogleAdsClient } from './ads/google-ads.client';
import { TikTokAdsClient } from './ads/tiktok-ads.client';
import { CreativeAdSpendProvider } from './providers/creative-ad-spend.provider';
import { CreativePlatformMetricsProvider } from './providers/creative-platform-metrics.provider';

/**
 * M10 — CREATIVE ANALYTICS.
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard, WorkspaceGuard e o provider
 * DRIZZLE já estão disponíveis (os services injetam DRIZZLE). Lê ClickHouse
 * `creative_daily` (reportado) + `creative_real_daily`/`events` (real) — sempre
 * workspace_id (regra 1); o lado real já exclui bots (regra 11, via MV).
 *
 * FORNECE OS TOKENS DO M7 e do M14 (o M10 é a "fonte real" prometida pelos stubs):
 *  - AD_SPEND_PROVIDER (do attribution/ad-spend.provider) → CreativeAdSpendProvider.
 *  - PLATFORM_METRICS_PROVIDER (do data-quality/platform-metrics) → CreativePlatformMetricsProvider.
 * Ambos são EXPORTADOS: na onda de integração o AttributionModule e o
 * DataQualityModule passam a `imports: [CreativesModule]` e removem seus stubs
 * locais (Unavailable*). Mesmo Symbol de token, mesma interface — sem tocar nos
 * services do M7/M14. Ver StructuredOutput.notes (WIRING).
 *
 * INTEGRAÇÃO: adicionar `CreativesModule` aos imports do AppModule (app.module.ts)
 * na onda de integração — NÃO editado aqui (contrato de arquivos) — ver nestModules.
 */
@Module({
  controllers: [CreativesController],
  providers: [
    CreativesService,
    CreativeAlertsService,
    AdsService,
    MetaAdsClient,
    GoogleAdsClient,
    TikTokAdsClient,
    CreativeAdSpendProvider,
    CreativePlatformMetricsProvider,
    // Religa os tokens do M7/M14 para as implementações reais do M10.
    { provide: AD_SPEND_PROVIDER, useExisting: CreativeAdSpendProvider },
    { provide: PLATFORM_METRICS_PROVIDER, useExisting: CreativePlatformMetricsProvider },
  ],
  exports: [
    CreativesService,
    CreativeAlertsService,
    AdsService,
    // Exportados p/ o AttributionModule (M7) e o DataQualityModule (M14) consumirem
    // via `imports: [CreativesModule]` na integração.
    AD_SPEND_PROVIDER,
    PLATFORM_METRICS_PROVIDER,
  ],
})
export class CreativesModule {}
