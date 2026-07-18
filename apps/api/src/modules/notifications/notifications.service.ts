import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  alertRules,
  notificationChannels,
  notificationPreferences,
  notifications,
  users,
  workspaceMembers,
  type AlertRule,
  type Notification,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationChannelConfig,
  type NotificationPreference,
  type NotificationSeverity,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';
import { resolveAlertType, type DispatchPayload } from './notification-types';

/** Resultado de um dispatch — quantos canais foram efetivamente entregues. */
export interface DispatchResult {
  delivered: boolean;
  reason?: string;
  notificationIds: string[];
  channels: { in_app: number; email: number; slack: boolean };
}

interface Recipient {
  id: string;
  email: string | null;
}

interface EffectivePref {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  slackEnabled: boolean;
  muted: boolean;
}

/** Notificação in-app serializada para o cliente (sino). */
export interface NotificationView {
  id: string;
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  link: string | null;
  group_count: number;
  read: boolean;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * M12 — NotificationService. Infra ÚNICA de notificação (PRD §7 M12).
 *
 * `dispatch(workspaceId, type, payload)` é a superfície que M5/M10/M14/M11/M17
 * chamam. Resolve regra (alert_rules) + preferências (por usuário/tipo) + config
 * de canal do workspace, aplica dedup/agrupamento e entrega em in-app/email/slack.
 * Exportado por NotificationsModule (@Global) — injetável em qualquer módulo.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly email: EmailChannel,
    private readonly slack: SlackChannel,
  ) {}

  /* ─────────────────────────────── dispatch ──────────────────────────────── */

  /**
   * Entrega um alerta. NÃO lança em falha de canal externo (fail-closed): o
   * in-app é a fonte de verdade; email/slack são best-effort e logam em falha.
   */
  async dispatch(
    workspaceId: string,
    type: string,
    payload: DispatchPayload = {},
  ): Promise<DispatchResult> {
    const empty: DispatchResult = {
      delivered: false,
      notificationIds: [],
      channels: { in_app: 0, email: 0, slack: false },
    };

    const def = resolveAlertType(type);
    const rule = await this.resolveRule(workspaceId, type, def.category);

    // Regra existe e está desligada → respeita a config do workspace (não entrega).
    if (rule && !rule.enabled) {
      return { ...empty, reason: 'rule_disabled' };
    }

    const category: NotificationCategory = rule?.category ?? def.category;
    const severity: NotificationSeverity = payload.severity ?? rule?.severity ?? def.severity;
    const channels: NotificationChannel[] =
      payload.channels ??
      (rule?.channels && rule.channels.length > 0 ? rule.channels : def.defaultChannels);
    const windowMin = rule?.dedupWindowMinutes ?? def.dedupWindowMinutes;
    const title = (payload.title ?? def.title(payload)).slice(0, 500);
    const body = payload.body ?? null;
    const data = payload.data ?? {};
    const link = payload.link ?? null;
    const dedupKey = this.buildDedupKey(type, payload.dedupId, windowMin);

    const recipients = await this.resolveRecipients(workspaceId, payload.userIds);
    if (recipients.length === 0) {
      return { ...empty, reason: 'no_recipients' };
    }

    const prefs = await this.loadPreferences(
      workspaceId,
      recipients.map((r) => r.id),
      type,
      category,
    );

    const wantsInApp = channels.includes('in_app');
    const wantsEmail = channels.includes('email');
    const wantsSlack = channels.includes('slack');

    const cfg = wantsEmail || wantsSlack ? await this.channelConfig(workspaceId) : null;
    const emailWorkspaceOn = cfg ? cfg.emailEnabled : true;

    const notificationIds: string[] = [];
    let emailCount = 0;

    for (const r of recipients) {
      const pref = this.prefFor(prefs, r.id, type, category);
      // 'critical' fura o mute total? Não — mute é escolha explícita do usuário.
      if (pref.muted) continue;

      if (wantsInApp && pref.inAppEnabled) {
        const id = await this.upsertInApp({
          workspaceId,
          userId: r.id,
          type,
          category,
          severity,
          title,
          body,
          data,
          link,
          dedupKey,
        });
        notificationIds.push(id);
      }

      if (
        wantsEmail &&
        pref.emailEnabled &&
        emailWorkspaceOn &&
        r.email &&
        this.email.isConfigured()
      ) {
        const sent = await this.email.send({
          to: r.email,
          subject: title,
          html: renderEmailHtml(title, body, link),
          from: cfg?.emailFrom ?? undefined,
        });
        if (sent) emailCount += 1;
      }
    }

    // Slack é canal de WORKSPACE (webhook compartilhado) — envia UMA vez, não por
    // usuário. A preferência de Slack por usuário fica reservada p/ DMs futuras.
    let slackSent = false;
    if (wantsSlack && cfg?.slackEnabled && cfg.slackWebhookUrl) {
      slackSent = await this.slack.send(cfg.slackWebhookUrl, { title, body, severity, link });
    }

    const delivered = notificationIds.length > 0 || emailCount > 0 || slackSent;
    if (!delivered) {
      this.logger.debug(
        `dispatch ${type} (ws=${workspaceId}) não entregou em nenhum canal (prefs/config).`,
      );
    }
    return {
      delivered,
      notificationIds,
      channels: { in_app: notificationIds.length, email: emailCount, slack: slackSent },
    };
  }

  /* ──────────────────────────── in-app (sino) ─────────────────────────────── */

  async listForUser(
    workspaceId: string,
    userId: string,
    opts: { status: 'all' | 'unread'; limit: number; before?: string },
  ): Promise<{ items: NotificationView[]; unread_count: number; next_before: string | null }> {
    const conds = [
      eq(notifications.workspaceId, workspaceId),
      eq(notifications.userId, userId),
    ];
    if (opts.status === 'unread') conds.push(isNull(notifications.readAt));
    if (opts.before) conds.push(lt(notifications.createdAt, new Date(opts.before)));

    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit);

    const unread = await this.unreadCount(workspaceId, userId);
    const last = rows.length === opts.limit ? rows[rows.length - 1] : undefined;
    return {
      items: rows.map(serializeNotification),
      unread_count: unread,
      next_before: last ? last.createdAt.toISOString() : null,
    };
  }

  async unreadCount(workspaceId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      );
    return rows[0]?.c ?? 0;
  }

  async markRead(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ id: string; read: true }> {
    const now = new Date();
    const rows = await this.db
      .update(notifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
        ),
      )
      .returning({ id: notifications.id });
    if (!rows[0]) throw new NotFoundException('Notificação não encontrada');
    return { id, read: true };
  }

  async markAllRead(workspaceId: string, userId: string): Promise<{ updated: number }> {
    const now = new Date();
    const rows = await this.db
      .update(notifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return { updated: rows.length };
  }

  /* ─────────────────────────────── helpers ───────────────────────────────── */

  private buildDedupKey(type: string, dedupId: string | undefined, windowMin: number): string {
    const id = dedupId ?? 'default';
    // Sem janela → sempre único (nunca agrupa).
    if (!Number.isFinite(windowMin) || windowMin <= 0) return `${type}:${id}:${ulid()}`;
    const bucket = Math.floor(Date.now() / (windowMin * 60_000));
    return `${type}:${id}:${bucket}`;
  }

  private async resolveRule(
    workspaceId: string,
    type: string,
    category: NotificationCategory,
  ): Promise<AlertRule | null> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(
        and(eq(alertRules.workspaceId, workspaceId), inArray(alertRules.type, [type, category])),
      );
    // Match exato por tipo tem prioridade sobre a regra de categoria.
    return rows.find((r) => r.type === type) ?? rows.find((r) => r.type === category) ?? null;
  }

  private async resolveRecipients(
    workspaceId: string,
    userIds?: string[],
  ): Promise<Recipient[]> {
    if (userIds && userIds.length > 0) {
      const rows = await this.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      return rows.map((r) => ({ id: String(r.id), email: r.email ?? null }));
    }
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.status, 'active'),
        ),
      );
    return rows.map((r) => ({ id: String(r.id), email: r.email ?? null }));
  }

  private async loadPreferences(
    workspaceId: string,
    userIds: string[],
    type: string,
    category: NotificationCategory,
  ): Promise<NotificationPreference[]> {
    if (userIds.length === 0) return [];
    return this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.workspaceId, workspaceId),
          inArray(notificationPreferences.userId, userIds),
          inArray(notificationPreferences.alertType, [type, category, '*']),
        ),
      );
  }

  /** Preferência efetiva do usuário: tipo específico > categoria > '*' > default. */
  private prefFor(
    prefs: NotificationPreference[],
    userId: string,
    type: string,
    category: NotificationCategory,
  ): EffectivePref {
    const mine = prefs.filter((p) => p.userId === userId);
    const pick = (at: string) => mine.find((p) => p.alertType === at);
    const p = pick(type) ?? pick(category) ?? pick('*');
    if (!p) return { inAppEnabled: true, emailEnabled: true, slackEnabled: false, muted: false };
    return {
      inAppEnabled: p.inAppEnabled,
      emailEnabled: p.emailEnabled,
      slackEnabled: p.slackEnabled,
      muted: p.muted,
    };
  }

  private async channelConfig(workspaceId: string): Promise<NotificationChannelConfig | null> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.workspaceId, workspaceId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insere a notificação in-app; em conflito de dedup, agrupa e re-surge. */
  private async upsertInApp(row: {
    workspaceId: string;
    userId: string;
    type: string;
    category: NotificationCategory;
    severity: NotificationSeverity;
    title: string;
    body: string | null;
    data: Record<string, unknown>;
    link: string | null;
    dedupKey: string;
  }): Promise<string> {
    const id = `ntf_${ulid()}`;
    const now = new Date();
    const rows = await this.db
      .insert(notifications)
      .values({ id, ...row })
      .onConflictDoUpdate({
        target: [notifications.workspaceId, notifications.userId, notifications.dedupKey],
        set: {
          title: row.title,
          body: row.body,
          data: row.data,
          severity: row.severity,
          link: row.link,
          groupCount: sql`${notifications.groupCount} + 1`,
          // re-surge como não-lida quando o mesmo alerta reincide na janela.
          readAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: notifications.id });
    return rows[0]?.id ?? id;
  }
}

/* ───────────────────────────── serialização ──────────────────────────────── */

function serializeNotification(n: Notification): NotificationView {
  return {
    id: n.id,
    type: n.type,
    category: n.category,
    severity: n.severity,
    title: n.title,
    body: n.body ?? null,
    data: n.data ?? {},
    link: n.link ?? null,
    group_count: n.groupCount,
    read: n.readAt !== null,
    read_at: n.readAt ? n.readAt.toISOString() : null,
    created_at: n.createdAt.toISOString(),
    updated_at: n.updatedAt.toISOString(),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML mínimo e inline (sem assets externos) para o e-mail transacional. */
function renderEmailHtml(title: string, body: string | null, link: string | null): string {
  const safeTitle = escapeHtml(title);
  const safeBody = body ? `<p style="margin:0 0 16px;color:#334155;">${escapeHtml(body)}</p>` : '';
  const cta = link
    ? `<a href="${escapeHtml(
        link,
      )}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Abrir no Truvo</a>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:28px;">
      <tr><td>
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;font-weight:700;">Truvo · Alerta</p>
        <h1 style="margin:0 0 12px;font-size:18px;color:#0f172a;">${safeTitle}</h1>
        ${safeBody}
        ${cta}
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Você recebe este e-mail por ter alertas ativos no Truvo. Ajuste em Configurações · Notificações.</p>
  </td></tr></table>
  </body></html>`;
}
