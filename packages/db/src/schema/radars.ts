import { foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { customers } from './customer-context';

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
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastDispatchedAt: timestamp('last_dispatched_at', { withTimezone: true }),
  terminalAt: timestamp('terminal_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.id] }),
  idempotency: uniqueIndex('radar_training_requests_idempotency_uq').on(table.workspaceId, table.radarId, table.definitionVersion, table.idempotencyKey),
  claimableIdx: index('radar_training_requests_claimable_idx').on(table.status, table.leaseExpiresAt),
  definitionFk: foreignKey({
    name: 'radar_training_requests_definition_fk',
    columns: [table.workspaceId, table.radarId, table.definitionVersion],
    foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version],
  }).onDelete('cascade'),
}));

/** Minimal reproducible ML registry. Artifact storage is intentionally a provider-neutral
 * boundary: production adapters must be durable and never use container-local paths. */
export const radarModelVersions = pgTable('radar_model_versions', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  trainingRequestId: text('training_request_id').notNull(),
  targetOutcomeDefinitionId: text('target_outcome_definition_id').notNull(),
  predictionWindowDays: integer('prediction_window_days').notNull(),
  status: text('status').notNull().default('candidate'),
  modelRole: text('model_role').notNull().default('propensity'),
  estimatorType: text('estimator_type').notNull(),
  featureSchemaVersion: text('feature_schema_version').notNull(),
  artifactProvider: text('artifact_provider').notNull().default('supabase_storage'),
  artifactBucket: text('artifact_bucket').notNull(),
  artifactObjectKey: text('artifact_object_key').notNull(),
  artifactReference: text('artifact_reference').notNull(),
  artifactChecksum: text('artifact_checksum').notNull(),
  serializationFormat: text('serialization_format').notNull().default('joblib-v1'),
  cutoffRanges: jsonb('cutoff_ranges').$type<Record<string, unknown>>().notNull(),
  dataCounts: jsonb('data_counts').$type<Record<string, unknown>>().notNull(),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
  calibration: jsonb('calibration').$type<Record<string, unknown>>().notNull(),
  provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
  validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
  selectionReason: text('selection_reason').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  definitionFk: foreignKey({ columns: [t.workspaceId, t.radarId, t.definitionVersion], foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version] }).onDelete('cascade'),
  requestFk: foreignKey({ columns: [t.workspaceId, t.trainingRequestId], foreignColumns: [radarTrainingRequests.workspaceId, radarTrainingRequests.id] }).onDelete('cascade'),
  requestUq: uniqueIndex('radar_model_versions_ws_request_uq').on(t.workspaceId, t.trainingRequestId),
  artifactUq: uniqueIndex('radar_model_versions_ws_artifact_uq').on(t.workspaceId, t.artifactBucket, t.artifactObjectKey),
}));

/** Append-only operational observations.  They are deliberately separate from the
 * immutable model record so monitoring never rewrites training provenance. */
export const radarModelMonitoringSnapshots = pgTable('radar_model_monitoring_snapshots', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  snapshotType: text('snapshot_type').notNull(),
  healthStatus: text('health_status').notNull(),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
  anomalies: jsonb('anomalies').$type<string[]>().notNull().default([]),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  modelFk: foreignKey({ columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('restrict'),
  modelObservedIdx: index('radar_model_monitoring_model_observed_idx').on(t.workspaceId, t.modelVersionId, t.observedAt),
}));

export const radarPropensityScores = pgTable('radar_propensity_scores', {
  workspaceId: text('workspace_id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  customerId: text('customer_id').notNull(),
  scoringCutoff: timestamp('scoring_cutoff', { withTimezone: true }).notNull(),
  probability: numeric('probability').notNull(),
  featureSchemaVersion: text('feature_schema_version').notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.radarId, t.modelVersionId, t.customerId, t.scoringCutoff] }),
  modelFk: foreignKey({ columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('cascade'),
  definitionFk: foreignKey({ columns: [t.workspaceId, t.radarId, t.definitionVersion], foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version] }).onDelete('cascade'),
  customerFk: foreignKey({ columns: [t.workspaceId, t.customerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('cascade'),
}));

/** One durable logical batch per model/cutoff. The worker owns the lease; score rows
 * are upserted under the same composite identity so retry is convergent. */
export const radarScoreBatches = pgTable('radar_score_batches', {
  workspaceId: text('workspace_id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  scoringCutoff: timestamp('scoring_cutoff', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('accepted'),
  claimedBy: text('claimed_by'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  scoredCustomerCount: integer('scored_customer_count').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.radarId, t.modelVersionId, t.scoringCutoff] }),
  modelFk: foreignKey({ columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('cascade'),
  definitionFk: foreignKey({ columns: [t.workspaceId, t.radarId, t.definitionVersion], foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version] }).onDelete('cascade'),
  recoverableIdx: index('radar_score_batches_recoverable_idx').on(t.status, t.leaseExpiresAt),
}));
