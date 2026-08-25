import { Module } from '@nestjs/common';
import { CreativesModule } from '../creatives/creatives.module';
import { DataQualityController } from './data-quality.controller';
import { ReconciliationService } from './reconciliation.service';
import { GatewayMetricsService } from './gateway-metrics.service';
import { BotDetectionService } from './bot-detection.service';
import { DiscrepancyService } from './discrepancy.service';
import { EventContextQualityService } from './event-context-quality.service';

/**
 * M14 — QUALIDADE DE DADOS & RECONCILIAÇÃO (lado da API).
 *
 * Auth (@Global M1): SupabaseAuthGuard/WorkspaceGuard/DRIZZLE não são re-providos.
 *
 * DI: PLATFORM_METRICS_PROVIDER é fornecido pelo M10 (CreativesModule exporta o token
 * via useExisting → CreativePlatformMetricsProvider). Importamos CreativesModule para o
 * DiscrepancyService receber as métricas REAIS da plataforma. Sem ciclo.
 * `BotDetectionService` é exportado para o consumer/M2 reusar o detector.
 */
@Module({
  imports: [CreativesModule],
  controllers: [DataQualityController],
  providers: [ReconciliationService, GatewayMetricsService, BotDetectionService, DiscrepancyService, EventContextQualityService],
  exports: [ReconciliationService, BotDetectionService, EventContextQualityService],
})
export class DataQualityModule {}
