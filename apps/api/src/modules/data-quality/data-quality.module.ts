import { Module } from '@nestjs/common';
import { DataQualityController } from './data-quality.controller';
import { ReconciliationService } from './reconciliation.service';
import { GatewayMetricsService } from './gateway-metrics.service';
import { BotDetectionService } from './bot-detection.service';
import { DiscrepancyService } from './discrepancy.service';
import {
  PLATFORM_METRICS_PROVIDER,
  UnavailablePlatformMetricsProvider,
} from './platform-metrics';

/**
 * M14 — QUALIDADE DE DADOS & RECONCILIAÇÃO (lado da API).
 *
 * Integração: adicionar `DataQualityModule` aos imports do AppModule na onda de
 * integração (app.module.ts NÃO é editado por este módulo — contrato de arquivos;
 * reportado em `nestModules`).
 *
 * Auth: os guards SupabaseAuthGuard/WorkspaceGuard vêm do AuthModule (@Global) —
 * não precisam ser re-providos aqui.
 *
 * DI notável:
 *  - PLATFORM_METRICS_PROVIDER → hoje o stub `UnavailablePlatformMetricsProvider`
 *    (M10 ausente). Na integração, o M10 fornece o provider real p/ o MESMO token
 *    sem tocar neste módulo. `BotDetectionService` é exportado para o consumer/M2
 *    (e futuros módulos) poderem reusar o detector.
 */
@Module({
  controllers: [DataQualityController],
  providers: [
    ReconciliationService,
    GatewayMetricsService,
    BotDetectionService,
    DiscrepancyService,
    { provide: PLATFORM_METRICS_PROVIDER, useClass: UnavailablePlatformMetricsProvider },
  ],
  exports: [ReconciliationService, BotDetectionService],
})
export class DataQualityModule {}
