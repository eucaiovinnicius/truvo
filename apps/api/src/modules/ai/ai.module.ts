import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution/attribution.module';
import { DataExplorerModule } from '../data-explorer/data-explorer.module';
import { AiController } from './ai.controller';
import { AiEvidenceService } from './evidence.service';
import { AiAnalystService } from './analyst.service';
import { AiLlmService } from './ai-llm.service';
import { AiRunsService } from './runs.service';
import { AiConversationsService } from './conversations.service';
import { NOTIFICATION_PROVIDER, UnavailableNotificationProvider } from './notification.provider';

/**
 * M17 — AI JOURNEY INTELLIGENCE.
 *
 * ARQUITETURA DETERMINISTIC-FIRST:
 *  · Fase 1 (AiEvidenceService): tudo no ClickHouse — REUSA o AttributionService (M7)
 *    para crédito multi-touch/jornadas/spend e lê `journey_paths_daily` (10-ai.sql) +
 *    `reconciliation_daily` (M14). É o "evidence pack".
 *  · Fase 2 (AiAnalystService + AiLlmService): o Claude recebe SÓ o pack e produz
 *    ranking/narrativa/insights/recomendações (nunca inventa número). Fail-closed sem
 *    ANTHROPIC_API_KEY.
 *  · Q&A (AiConversationsService): text-to-query REUSANDO o ExplorerService (M16) —
 *    nunca SQL cru.
 *
 * DI / integração:
 *  · importa AttributionModule (exporta AttributionService) e DataExplorerModule
 *    (exporta ExplorerService). DRIZZLE + guards vêm do AuthModule (@Global).
 *  · NOTIFICATION_PROVIDER → hoje o stub `UnavailableNotificationProvider` (M12
 *    ausente). Na integração, o M12 fornece o provider real p/ o MESMO token — mesmo
 *    padrão do M7 (AD_SPEND_PROVIDER) / M14 (PLATFORM_METRICS_PROVIDER). As anomalias
 *    detectadas deterministicamente são roteadas por ele.
 *
 * INTEGRAÇÃO: adicionar `AiModule` aos imports do AppModule (app.module.ts) na onda de
 * integração — ver StructuredOutput.nestModules. NÃO editado aqui p/ evitar conflito
 * com módulos paralelos.
 */
@Module({
  imports: [AttributionModule, DataExplorerModule],
  controllers: [AiController],
  providers: [
    AiLlmService,
    AiEvidenceService,
    AiAnalystService,
    AiRunsService,
    AiConversationsService,
    { provide: NOTIFICATION_PROVIDER, useClass: UnavailableNotificationProvider },
  ],
  exports: [AiRunsService, AiEvidenceService],
})
export class AiModule {}
