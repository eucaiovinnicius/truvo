import { integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const radars = pgTable('radars', {
  workspaceId: text('workspace_id').notNull(), id: text('id').notNull(), name: text('name').notNull(),
  status: text('status').notNull().default('draft'), currentDefinitionVersion: integer('current_definition_version').notNull().default(1),
  currentModelReference: text('current_model_reference'), pausedAt: timestamp('paused_at', { withTimezone: true }), archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.id] }), workspaceName: uniqueIndex('radars_ws_name_uq').on(t.workspaceId, t.name) }));

export const radarDefinitionVersions = pgTable('radar_definition_versions', {
  workspaceId: text('workspace_id').notNull(), radarId: text('radar_id').notNull(), version: integer('version').notNull(), outcomeDefinitionId: text('outcome_definition_id').notNull(),
  audienceAst: jsonb('audience_ast').$type<Record<string, unknown>>().notNull(), predictionWindowDays: integer('prediction_window_days').notNull(), optimizationGoal: jsonb('optimization_goal').$type<Record<string, unknown>>().notNull().default({}),
  activationDestination: jsonb('activation_destination').$type<Record<string, unknown>>(), readiness: jsonb('readiness').$type<Record<string, unknown>>(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.radarId, t.version] }) }));

export const radarTrainingRequests = pgTable('radar_training_requests', {
  workspaceId: text('workspace_id').notNull(), id: text('id').notNull(), radarId: text('radar_id').notNull(), definitionVersion: integer('definition_version').notNull(), idempotencyKey: text('idempotency_key').notNull(), status: text('status').notNull().default('accepted'), correlationId: text('correlation_id').notNull(), modelReference: text('model_reference'), failureReason: text('failure_reason'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.id] }), idempotency: uniqueIndex('radar_training_requests_idempotency_uq').on(t.workspaceId, t.radarId, t.definitionVersion, t.idempotencyKey) }));
