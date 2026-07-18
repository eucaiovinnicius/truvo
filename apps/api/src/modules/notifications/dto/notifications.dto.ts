import { z } from 'zod';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
} from '@truvo/db';

/**
 * DTOs (zod) do M12 — validados pelo ZodValidationPipe (mesmo padrão do M14/M16).
 * O `workspace_id` NUNCA vem do corpo/query: é resolvido do contexto
 * (`@CurrentWorkspace('id')`) — regra 1.
 */

const channelEnum = z.enum(NOTIFICATION_CHANNELS);
const categoryEnum = z.enum(NOTIFICATION_CATEGORIES);
const severityEnum = z.enum(NOTIFICATION_SEVERITIES);

/** GET /v1/notifications?status=&limit=&before= */
export const listNotificationsQuerySchema = z.object({
  /** 'unread' filtra não-lidas; 'all' (default) inclui lidas. */
  status: z.enum(['all', 'unread']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor keyset: só notificações criadas ANTES deste ISO. */
  before: z.string().datetime({ offset: true }).optional(),
});
export type ListNotificationsQueryDto = z.infer<typeof listNotificationsQuerySchema>;

/** PATCH /v1/notifications/preferences — upsert parcial por tipo. */
export const upsertPreferenceSchema = z
  .object({
    /** Tipo/categoria específica ou '*' (default do usuário). */
    alert_type: z.string().trim().min(1).max(120).default('*'),
    in_app_enabled: z.boolean().optional(),
    email_enabled: z.boolean().optional(),
    slack_enabled: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.in_app_enabled !== undefined ||
      v.email_enabled !== undefined ||
      v.slack_enabled !== undefined ||
      v.muted !== undefined,
    { message: 'informe ao menos um campo para atualizar' },
  );
export type UpsertPreferenceDto = z.infer<typeof upsertPreferenceSchema>;

/** POST /v1/alerts/rules — cria uma regra. */
export const createAlertRuleSchema = z.object({
  type: z.string().trim().min(1).max(120),
  category: categoryEnum.default('system'),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  severity: severityEnum.default('warning'),
  channels: z.array(channelEnum).min(1).default(['in_app']),
  config: z.record(z.unknown()).default({}),
  dedup_window_minutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
});
export type CreateAlertRuleDto = z.infer<typeof createAlertRuleSchema>;

/** PATCH /v1/alerts/rules/:id — atualização parcial. */
export const updateAlertRuleSchema = createAlertRuleSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateAlertRuleDto = z.infer<typeof updateAlertRuleSchema>;

/** PATCH /v1/notifications/channels — config de canal do workspace. */
export const updateChannelsSchema = z
  .object({
    slack_enabled: z.boolean().optional(),
    slack_webhook_url: z.string().url().max(500).nullable().optional(),
    slack_channel: z.string().trim().max(120).nullable().optional(),
    email_enabled: z.boolean().optional(),
    email_from: z.string().email().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateChannelsDto = z.infer<typeof updateChannelsSchema>;
