import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { NotificationService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import {
  listNotificationsQuerySchema,
  updateChannelsSchema,
  upsertPreferenceSchema,
  type ListNotificationsQueryDto,
  type UpdateChannelsDto,
  type UpsertPreferenceDto,
} from './dto/notifications.dto';

/**
 * M12 — Central de notificações (sino) + preferências + canais (PRD §7 M12).
 *
 * Auth: SupabaseAuthGuard (JWT do M1) + WorkspaceGuard (membership + papel). O
 * `workspace_id` vem do contexto (`@CurrentWorkspace('id')`, header
 * `x-workspace-id`) e o destinatário é sempre o próprio usuário
 * (`@CurrentUser('id')`) — regra 1; o cliente nunca escolhe no corpo.
 *
 *   GET   /v1/notifications?status=&limit=&before=
 *   PATCH /v1/notifications/read-all
 *   PATCH /v1/notifications/:id/read
 *   GET   /v1/notifications/preferences
 *   PATCH /v1/notifications/preferences
 *   GET   /v1/notifications/channels           (owner/admin — config do workspace)
 *   PATCH /v1/notifications/channels           (owner/admin)
 *
 * Rotas estáticas (preferences/channels/read-all) são declaradas ANTES de
 * `:id/read` p/ evitar captura pela rota paramétrica (Express casa por ordem).
 */
@Controller('v1/notifications')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: PreferencesService,
  ) {}

  /** Lista in-app do usuário no workspace (sino) + contagem de não-lidas. */
  @Get()
  list(
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) q: ListNotificationsQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.notifications.listForUser(workspaceId, userId, {
      status: q.status,
      limit: q.limit,
      before: q.before,
    });
  }

  /** Preferências de canal do usuário (por tipo). */
  @Get('preferences')
  getPreferences(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.preferences.getPreferences(workspaceId, userId);
  }

  /** Upsert de uma preferência (por tipo/'*'). */
  @Patch('preferences')
  upsertPreference(
    @Body(new ZodValidationPipe(upsertPreferenceSchema)) dto: UpsertPreferenceDto,
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.preferences.upsertPreference(workspaceId, userId, dto);
  }

  /** Config de canal do workspace (Slack/email) — só indica se há webhook. */
  @Get('channels')
  @Roles('owner', 'admin')
  getChannels(@CurrentWorkspace('id') workspaceId: string) {
    return this.preferences.getChannels(workspaceId);
  }

  @Patch('channels')
  @Roles('owner', 'admin')
  updateChannels(
    @Body(new ZodValidationPipe(updateChannelsSchema)) dto: UpdateChannelsDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.preferences.updateChannels(workspaceId, dto);
  }

  /** Marca TODAS as não-lidas do usuário como lidas. */
  @Patch('read-all')
  markAllRead(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.notifications.markAllRead(workspaceId, userId);
  }

  /** Marca UMA notificação como lida (só a do próprio usuário). */
  @Patch(':id/read')
  markRead(
    @Param('id') id: string,
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.notifications.markRead(workspaceId, userId, id);
  }
}
