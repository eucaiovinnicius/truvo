import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Order 035 §4 — AUDIT. Trilha genérica de mudanças de segurança/admin, workspace-
 * -scoped: membership/role, ciclo de vida de API key, CRUD de conector, operações
 * destrutivas e configuração privilegiada. Complementa (não substitui)
 * `profile_access_log` (M15, LGPD "quem viu qual pessoa") — este aqui é sobre
 * MUDANÇAS de estado de segurança/config, não sobre leitura de PII individual.
 *
 * `category`/`action` são texto namespaced (mesma convenção de `source_namespace`
 * do customer-context) em vez de enum fechado — o conjunto de eventos auditáveis
 * cresce com o produto; um enum fechado exigiria migração a cada novo evento.
 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'api_key'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const auditActorTypeEnum = pgEnum('audit_actor_type', AUDIT_ACTOR_TYPES);

export interface AuditMetadata {
  [key: string]: unknown;
}

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(), // aud_<ulid>
    workspaceId: text('workspace_id').notNull(),
    category: text('category').notNull(), // ex.: 'membership' | 'api_key' | 'connector' | 'data_lifecycle' | 'admin_config'
    action: text('action').notNull(), // ex.: 'membership.role_changed', 'api_key.created'
    actorType: auditActorTypeEnum('actor_type').notNull().default('user'),
    actorUserId: text('actor_user_id'),
    actorEmail: text('actor_email'),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull().default(''),
    /** NUNCA PII/segredos em claro — só metadados não sensíveis (mesma regra do profile_access_log). */
    metadata: jsonb('metadata').$type<AuditMetadata>().notNull().default(sql`'{}'::jsonb`),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceAtIdx: index('audit_log_ws_at_idx').on(t.workspaceId, t.at),
    actorIdx: index('audit_log_ws_actor_at_idx').on(t.workspaceId, t.actorUserId, t.at),
    categoryIdx: index('audit_log_ws_category_at_idx').on(t.workspaceId, t.category, t.at),
    resourceIdx: index('audit_log_ws_resource_idx').on(t.workspaceId, t.resourceType, t.resourceId),
    categoryCheck: check('audit_log_category_check', sql`length(trim(${t.category})) > 0`),
    actionCheck: check('audit_log_action_check', sql`length(trim(${t.action})) > 0`),
    resourceTypeCheck: check('audit_log_resource_type_check', sql`length(trim(${t.resourceType})) > 0`),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
