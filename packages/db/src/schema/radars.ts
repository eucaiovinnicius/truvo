import { foreignKey, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const radars = pgTable('radars', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'),
  currentDefinitionVersion: integer('current_definition_version').notNull().default(1),
  currentModelReference: text('current_model_reference'),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.id] }),
  workspaceName: uniqueIndex('radars_ws_name_uq').on(table.workspaceId, table.name),
}));

export const radarDefinitionVersions = pgTable('radar_definition_versions', {
  workspaceId: text('workspace_id').notNull(),
  radarId: text('radar_id').notNull(),
  version: integer('version').notNull(),
  outcomeDefinitionId: text('outcome_definition_id').notNull(),
  audienceAst: jsonb('audience_ast').$type<Record<string, unknown>>().notNull(),
  predictionWindowDays: integer('prediction_window_days').notNull(),
  optimizationGoal: jsonb('optimization_goal').$type<Record<string, unknown>>().notNull().default({}),
  activationDestination: jsonb('activation_destination').$type<Record<string, unknown>>(),
  readiness: jsonb('readiness').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.radarId, table.version] }),
  radarFk: foreignKey({
    name: 'radar_definition_versions_radar_fk',
    columns: [table.workspaceId, table.radarId],
    foreignColumns: [radars.workspaceId, radars.id],
  }).onDelete('cascade'),
}));

export const radarTrainingRequests = pgTable('radar_training_requests', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').notNull().default('accepted'),
  correlationId: text('correlation_id').notNull(),
  modelReference: text('model_reference'),
  failureCategory: text('failure_category'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.id] }),
  idempotency: uniqueIndex('radar_training_requests_idempotency_uq').on(table.workspaceId, table.radarId, table.definitionVersion, table.idempotencyKey),
  oneRequestPerDefinition: uniqueIndex('radar_training_requests_one_per_definition_uq').on(table.workspaceId, table.radarId, table.definitionVersion),
  definitionFk: foreignKey({
    name: 'radar_training_requests_definition_fk',
    columns: [table.workspaceId, table.radarId, table.definitionVersion],
    foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version],
  }).onDelete('cascade'),
}));

/** Minimal reproducible ML registry. Artifact storage is intentionally a provider-neutral
 * boundary: production adapters must be durable and never use container-local paths. */
export const radarModelVersions = pgTable('radar_model_versions', {
  workspaceId: text('workspace_id').notNull(), id: text('id').notNull(), radarId: text('radar_id').notNull(), definitionVersion: integer('definition_version').notNull(), trainingRequestId: text('training_request_id').notNull(),
  status: text('status').notNull().default('candidate'), estimatorType: text('estimator_type').notNull(), featureSchemaVersion: text('feature_schema_version').notNull(), artifactReference: text('artifact_reference').notNull(), artifactChecksum: text('artifact_checksum').notNull(),
  cutoffRanges: jsonb('cutoff_ranges').$type<Record<string, unknown>>().notNull(), dataCounts: jsonb('data_counts').$type<Record<string, unknown>>().notNull(), metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(), calibration: jsonb('calibration').$type<Record<string, unknown>>().notNull(), promotedAt: timestamp('promoted_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.id] }), definitionFk: foreignKey({ columns: [t.workspaceId, t.radarId, t.definitionVersion], foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version] }).onDelete('cascade'), requestFk: foreignKey({ columns: [t.workspaceId, t.trainingRequestId], foreignColumns: [radarTrainingRequests.workspaceId, radarTrainingRequests.id] }).onDelete('cascade'), requestUq: uniqueIndex('radar_model_versions_ws_request_uq').on(t.workspaceId, t.trainingRequestId) }));

export const radarPropensityScores = pgTable('radar_propensity_scores', {
  workspaceId: text('workspace_id').notNull(), radarId: text('radar_id').notNull(), modelVersionId: text('model_version_id').notNull(), customerId: text('customer_id').notNull(), scoringCutoff: timestamp('scoring_cutoff', { withTimezone: true }).notNull(), probability: numeric('probability').notNull(), featureSchemaVersion: text('feature_schema_version').notNull(), reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]), scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.radarId, t.modelVersionId, t.customerId, t.scoringCutoff] }), modelFk: foreignKey({ columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('cascade') }));
