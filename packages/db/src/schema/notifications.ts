import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * M12 — NOTIFICAÇÕES & ALERTAS (schema Postgres).
 *
 * Infra ÚNICA de notificação que M5 (funil), M10 (criativos), M14 (qualidade),
 * M11 (billing) e M17 (IA) usam. Sem ela, "alerta" viraria código solto em cada
 * módulo (PRD §7 M12). Tudo aqui vive no Postgres (não há DDL ClickHouse nova):
 *
 *   - notifications            → central in-app (sino da topbar), lido/não-lido,
 *                                dedup/agrupamento e HISTÓRICO por usuário.
 *   - alert_rules              → CRUD de regras de alerta por workspace (tipo,
 *                                canais, severidade, janela de dedup, config).
 *   - notification_preferences → preferências de canal por usuário e por tipo
 *                                (in-app/email/slack + mute).
 *   - notification_channels    → config de canal em nível de WORKSPACE (webhook
 *                                do Slack, remetente de e-mail). O webhook do
 *                                Slack é "por workspace" (PRD §7 M12) — não cabe
 *                                em preferences (que é por usuário).
 *
 * Regras respeitadas:
 *   1 — toda leitura/escrita filtra por workspace_id (índices abaixo).
 *  12 — alertas de qualidade/reconciliação roteados por aqui (o M14 grava o
 *       alerta; o M12 entrega — ver NotificationService.dispatch + openTODOs).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './notifications'`) na onda de
 * integração para que `@truvo/db` exponha `notifications`, `alertRules`,
 * `notificationPreferences` e `notificationChannels`. O barrel NÃO é editado por
 * este módulo (contrato de arquivos) — reportado em `schemaExports`.
 *
 * Obs.: `workspace_id` e `user_id` são `text` (não FK) para permanecer
 * compatíveis com o formato de id do M1 (Auth) e com `@CurrentWorkspace('id')`/
 * `@CurrentUser('id')` (ambos `string`) — mesmo padrão do M14 (data-quality).
 */

/** Categorias de alerta registradas por regra (PRD §7 M12). */
export const NOTIFICATION_CATEGORIES = [
  'funnel',
  'creative',
  'quality',
  'billing',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Severidade — controla realce no sino e roteamento (critical nunca é mudo). */
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Canais de entrega suportados (PRD §7 M12). */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'slack'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * notifications — 1 linha por notificação in-app entregue a UM usuário. É também
 * o histórico do sino. Dedup/agrupamento por (workspace, user, dedup_key): um
 * novo disparo do mesmo alerta dentro da janela incrementa `group_count` e
 * re-surge (read_at → null) em vez de criar spam.
 */
export const notifications = pgTable(
  'notifications',
  {
    /** Gerado no serviço: `ntf_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /** Destinatário (= users.id do M1). */
    userId: text('user_id').notNull(),
    /** Tipo do alerta (ex.: 'funnel.conversion_below_threshold'). */
    type: text('type').notNull(),
    category: text('category').$type<NotificationCategory>().notNull().default('system'),
    severity: text('severity').$type<NotificationSeverity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    /** Payload estruturado do evento (ids, métricas, deltas). */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Deep-link no app ao clicar (ex.: `/funnels/<id>`). */
    link: text('link'),
    /** Chave de dedup/agrupamento (type + identidade estável + bucket de tempo). */
    dedupKey: text('dedup_key').notNull(),
    /** Quantas ocorrências foram agrupadas nesta linha (>= 1). */
    groupCount: integer('group_count').notNull().default(1),
    /** Nulo = não-lida. Preenchido quando o usuário marca como lida. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // lista do sino (regra 1: sempre escopado por workspace+usuário).
    recipientIdx: index('notifications_recipient_idx').on(
      t.workspaceId,
      t.userId,
      t.createdAt,
    ),
    // contagem de não-lidas (read_at IS NULL).
    unreadIdx: index('notifications_unread_idx').on(t.workspaceId, t.userId, t.readAt),
    // dedup/agrupamento: no máximo 1 linha viva por (workspace, user, dedup_key).
    dedupUq: uniqueIndex('notifications_dedup_uq').on(t.workspaceId, t.userId, t.dedupKey),
  }),
);

/**
 * alert_rules — regras configuráveis por workspace. O dispatch resolve a regra
 * por `type` (ou por `category` como fallback). Se existe regra e está desligada,
 * o alerta NÃO é entregue (respeita a config do workspace). Sem regra → usa o
 * default do registry de tipos (in-app ligado).
 */
export const alertRules = pgTable(
  'alert_rules',
  {
    /** Gerado no serviço: `alr_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** Tipo específico ('funnel.conversion_below_threshold') OU categoria ('quality'). */
    type: text('type').notNull(),
    category: text('category').$type<NotificationCategory>().notNull().default('system'),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    severity: text('severity').$type<NotificationSeverity>().notNull().default('warning'),
    /** Canais da regra (a preferência do usuário ainda pode reduzir). */
    channels: jsonb('channels')
      .$type<NotificationChannel[]>()
      .notNull()
      .default(sql`'["in_app"]'::jsonb`),
    /** Config específica do tipo (ex.: { threshold: 0.02 }) — lida pelo módulo de origem. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Janela de dedup/agrupamento em minutos (0 = sem agrupamento). */
    dedupWindowMinutes: integer('dedup_window_minutes').notNull().default(60),
    /** Usuário que criou a regra (= users.id). */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('alert_rules_workspace_idx').on(t.workspaceId),
    // resolução rápida por tipo no dispatch.
    workspaceTypeIdx: index('alert_rules_workspace_type_idx').on(t.workspaceId, t.type),
  }),
);

/**
 * notification_preferences — preferências de canal por usuário e por tipo
 * (PRD §7 M12). `alert_type = '*'` é o default do usuário para todos os tipos;
 * uma linha por tipo específico o sobrescreve. `muted` silencia o tipo.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    /** Gerado no serviço: `npf_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    /** Tipo/categoria de alerta ou '*' (default do usuário). */
    alertType: text('alert_type').notNull().default('*'),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    slackEnabled: boolean('slack_enabled').notNull().default(false),
    /** Silencia totalmente este tipo para o usuário. */
    muted: boolean('muted').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 1 preferência por (workspace, user, tipo).
    uq: uniqueIndex('notification_preferences_uq').on(t.workspaceId, t.userId, t.alertType),
    byUser: index('notification_preferences_user_idx').on(t.workspaceId, t.userId),
  }),
);

/**
 * notification_channels — config de canal em nível de WORKSPACE. O webhook do
 * Slack é "incoming por workspace" (PRD §7 M12) e o remetente de e-mail pode ser
 * sobrescrito por workspace (white-label). 1 linha por workspace.
 */
export const notificationChannels = pgTable('notification_channels', {
  workspaceId: text('workspace_id').primaryKey(),
  slackEnabled: boolean('slack_enabled').notNull().default(false),
  /**
   * Incoming webhook do Slack (SEGREDO).
   * TODO(live): cifrar em repouso reusando o AES-256-GCM do M4
   * (INTEGRATIONS_ENCRYPTION_KEY) — hoje texto puro, aceitável em dev.
   */
  slackWebhookUrl: text('slack_webhook_url'),
  /** Canal informativo (o webhook já fixa o destino). */
  slackChannel: text('slack_channel'),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  /** Override do remetente; default vem de NOTIFICATIONS_EMAIL_FROM. */
  emailFrom: text('email_from'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Tipos inferidos ─────────────────────────────────────────────────────────
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type AlertRule = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
export type NotificationChannelConfig = typeof notificationChannels.$inferSelect;
export type NewNotificationChannelConfig = typeof notificationChannels.$inferInsert;
