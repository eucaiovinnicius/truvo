import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution/attribution.module';
import { DataExplorerModule } from '../data-explorer/data-explorer.module';
import { NotificationService } from '../notifications/notifications.service';
import { AiController } from './ai.controller';
import { AiEvidenceService } from './evidence.service';
import { AiAnalystService } from './analyst.service';
import { AiLlmService } from './ai-llm.service';
import { AiRunsService } from './runs.service';
import { AiConversationsService } from './conversations.service';
import {
  NOTIFICATION_PROVIDER,
  type NotificationProvider,
  type NotificationMessage,
} from './notification.provider';

/**
 * M17 — AI JOURNEY INTELLIGENCE (deterministic-first).
 *
 *  · Fase 1 (AiEvidenceService): tudo no ClickHouse — reusa AttributionService (M7),
 *    lê journey_paths_daily (10-ai.sql) + reconciliation_daily (M14). "Evidence pack".
 *  · Fase 2 (AiAnalystService + AiLlmService): o Claude recebe SÓ o pack (nunca inventa
 *    número). Fail-closed sem ANTHROPIC_API_KEY.
 *  · Q&A (AiConversationsService): text-to-query reusando o ExplorerService (M16).
 *
 * DI: importa AttributionModule + DataExplorerModule. NOTIFICATION_PROVIDER é uma PONTE
 * para o NotificationService do M12 (@Global) — anomalias detectadas deterministicamente
 * viram `dispatch(workspaceId, 'ai.<kind>', …)`.
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
    {
      provide: NOTIFICATION_PROVIDER,
      useFactory: (notifications: NotificationService): NotificationProvider => ({
        notify: (msg: NotificationMessage) =>
          notifications
            .dispatch(msg.workspaceId, `ai.${msg.kind}`, {
              title: msg.title,
              body: msg.body,
              data: msg.data,
            })
            .then(() => undefined),
        isAvailable: () => true,
      }),
      inject: [NotificationService],
    },
  ],
  exports: [AiRunsService, AiEvidenceService],
})
export class AiModule {}
