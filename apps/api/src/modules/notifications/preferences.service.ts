import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  notificationChannels,
  notificationPreferences,
  type NotificationChannelConfig,
  type NotificationPreference,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import type { UpdateChannelsDto, UpsertPreferenceDto } from './dto/notifications.dto';

export interface PreferenceView {
  alert_type: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  slack_enabled: boolean;
  muted: boolean;
  updated_at: string;
}

export interface ChannelsView {
  slack_enabled: boolean;
  /** Só indica SE há webhook — nunca devolve o segredo em claro. */
  slack_webhook_configured: boolean;
  slack_channel: string | null;
  email_enabled: boolean;
  email_from: string | null;
  updated_at: string | null;
}

/**
 * M12 — Preferências de canal por usuário/tipo + config de canal do workspace.
 * Preferências são por usuário (qualquer papel); a config de canal (webhook do
 * Slack, remetente) é de workspace e restrita a owner/admin no controller.
 */
@Injectable()
export class PreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ───────────────────────── preferências (usuário) ──────────────────────── */

  async getPreferences(workspaceId: string, userId: string): Promise<PreferenceView[]> {
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.workspaceId, workspaceId),
          eq(notificationPreferences.userId, userId),
        ),
      )
      .orderBy(asc(notificationPreferences.alertType));
    return rows.map(serializePref);
  }

  /** Upsert de UMA preferência (chave: workspace+user+alert_type). */
  async upsertPreference(
    workspaceId: string,
    userId: string,
    dto: UpsertPreferenceDto,
  ): Promise<PreferenceView> {
    const now = new Date();
    const insert = {
      id: `npf_${ulid()}`,
      workspaceId,
      userId,
      alertType: dto.alert_type,
      inAppEnabled: dto.in_app_enabled ?? true,
      emailEnabled: dto.email_enabled ?? true,
      slackEnabled: dto.slack_enabled ?? false,
      muted: dto.muted ?? false,
      updatedAt: now,
    };
    // Só sobrescreve os campos informados (patch parcial no conflito).
    const set: Partial<typeof notificationPreferences.$inferInsert> = { updatedAt: now };
    if (dto.in_app_enabled !== undefined) set.inAppEnabled = dto.in_app_enabled;
    if (dto.email_enabled !== undefined) set.emailEnabled = dto.email_enabled;
    if (dto.slack_enabled !== undefined) set.slackEnabled = dto.slack_enabled;
    if (dto.muted !== undefined) set.muted = dto.muted;

    const rows = await this.db
      .insert(notificationPreferences)
      .values(insert)
      .onConflictDoUpdate({
        target: [
          notificationPreferences.workspaceId,
          notificationPreferences.userId,
          notificationPreferences.alertType,
        ],
        set,
      })
      .returning();
    const row = rows[0];
    // returning sempre traz a linha (insert ou update). Fallback defensivo:
    return row ? serializePref(row) : serializePref({ ...insert } as NotificationPreference);
  }

  /* ─────────────────────── canais (workspace, admin) ─────────────────────── */

  async getChannels(workspaceId: string): Promise<ChannelsView> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.workspaceId, workspaceId))
      .limit(1);
    return serializeChannels(workspaceId, rows[0] ?? null);
  }

  async updateChannels(workspaceId: string, dto: UpdateChannelsDto): Promise<ChannelsView> {
    const now = new Date();
    const set: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: now };
    if (dto.slack_enabled !== undefined) set.slackEnabled = dto.slack_enabled;
    if (dto.slack_webhook_url !== undefined) set.slackWebhookUrl = dto.slack_webhook_url;
    if (dto.slack_channel !== undefined) set.slackChannel = dto.slack_channel;
    if (dto.email_enabled !== undefined) set.emailEnabled = dto.email_enabled;
    if (dto.email_from !== undefined) set.emailFrom = dto.email_from;

    const rows = await this.db
      .insert(notificationChannels)
      .values({
        workspaceId,
        slackEnabled: dto.slack_enabled ?? false,
        slackWebhookUrl: dto.slack_webhook_url ?? null,
        slackChannel: dto.slack_channel ?? null,
        emailEnabled: dto.email_enabled ?? true,
        emailFrom: dto.email_from ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: notificationChannels.workspaceId, set })
      .returning();
    return serializeChannels(workspaceId, rows[0] ?? null);
  }
}

function serializePref(p: NotificationPreference): PreferenceView {
  return {
    alert_type: p.alertType,
    in_app_enabled: p.inAppEnabled,
    email_enabled: p.emailEnabled,
    slack_enabled: p.slackEnabled,
    muted: p.muted,
    updated_at: p.updatedAt.toISOString(),
  };
}

function serializeChannels(
  workspaceId: string,
  c: NotificationChannelConfig | null,
): ChannelsView {
  if (!c) {
    return {
      slack_enabled: false,
      slack_webhook_configured: false,
      slack_channel: null,
      email_enabled: true,
      email_from: null,
      updated_at: null,
    };
  }
  return {
    slack_enabled: c.slackEnabled,
    slack_webhook_configured: Boolean(c.slackWebhookUrl),
    slack_channel: c.slackChannel ?? null,
    email_enabled: c.emailEnabled,
    email_from: c.emailFrom ?? null,
    updated_at: c.updatedAt.toISOString(),
  };
}
