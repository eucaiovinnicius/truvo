import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { AlertRulesController } from './alert-rules.controller';
import { NotificationService } from './notifications.service';
import { AlertRulesService } from './alert-rules.service';
import { PreferencesService } from './preferences.service';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';

/**
 * M12 — NOTIFICAÇÕES & ALERTAS. Infra ÚNICA de notificação (PRD §7 M12).
 *
 * @Global: `NotificationService` fica injetável em QUALQUER módulo sem re-importar
 * este módulo — é o que M5 (funil), M10 (criativos), M14 (qualidade), M11
 * (billing) e M17 (IA) chamam via `dispatch(workspaceId, type, payload)`. Mesmo
 * espírito do AuthModule (@Global).
 *
 * Depende da infra @Global do M1 (AuthModule): DRIZZLE + SupabaseAuthGuard +
 * WorkspaceGuard — não re-provido aqui. Persiste tudo no Postgres (sino/histórico,
 * regras, preferências, config de canal); email/slack saem por fetch nativo
 * (fail-closed sem credencial — ver EmailChannel/SlackChannel + openTODOs).
 *
 * INTEGRAÇÃO: adicionar `NotificationsModule` aos imports do AppModule
 * (apps/api/src/app.module.ts) na onda de integração — ver StructuredOutput.
 * nestModules. NÃO editado aqui p/ evitar conflito com módulos paralelos.
 */
@Global()
@Module({
  controllers: [NotificationsController, AlertRulesController],
  providers: [
    NotificationService,
    AlertRulesService,
    PreferencesService,
    EmailChannel,
    SlackChannel,
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
