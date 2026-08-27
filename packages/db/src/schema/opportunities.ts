import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { customers } from './customer-context';
import { connectorConnections } from './connectors';
import {
  radarDefinitionVersions,
  radarModelVersions,
  radarScoreBatches,
  radars,
} from './radars';

/**
 * An Opportunity batch is immutable provenance until its final, transactional
 * promotion. `is_current` is an integer for compatibility with migration 0020;
 * checks below retain boolean semantics at the database boundary.
 */
export const opportunityBatches = pgTable('opportunity_batches', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  scoreCutoff: timestamp('score_cutoff', { withTimezone: true }).notNull(),
  policyVersion: text('policy_version').notNull().default('opportunity-v1'),
  status: text('status').notNull().default('building'),
  isCurrent: integer('is_current').notNull().default(0),
  triggerReason: text('trigger_reason').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  eligibleCount: integer('eligible_count').notNull().default(0),
  monetaryRowCount: integer('monetary_row_count').notNull().default(0),
  aggregateExpectedRevenue: numeric('aggregate_expected_revenue'),
  aggregateCurrency: text('aggregate_currency'),
  materializedAt: timestamp('materialized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  radarFk: foreignKey({
    name: 'opportunity_batches_radar_fk',
    columns: [t.workspaceId, t.radarId],
    foreignColumns: [radars.workspaceId, radars.id],
  }).onDelete('restrict'),
  definitionFk: foreignKey({
    name: 'opportunity_batches_definition_fk',
    columns: [t.workspaceId, t.radarId, t.definitionVersion],
    foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version],
  }).onDelete('restrict'),
  modelFk: foreignKey({
    name: 'opportunity_batches_model_fk',
    columns: [t.workspaceId, t.modelVersionId],
    foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id],
  }).onDelete('restrict'),
  scoreBatchFk: foreignKey({
    name: 'opportunity_batches_score_batch_fk',
    columns: [t.workspaceId, t.radarId, t.modelVersionId, t.scoreCutoff],
    foreignColumns: [radarScoreBatches.workspaceId, radarScoreBatches.radarId, radarScoreBatches.modelVersionId, radarScoreBatches.scoringCutoff],
  }).onDelete('restrict'),
  current: uniqueIndex('opportunity_batches_one_current_uq')
    .on(t.workspaceId, t.radarId)
    .where(sql`${t.isCurrent} = 1`),
  logical: uniqueIndex('opportunity_batches_logical_uq')
    .on(t.workspaceId, t.radarId, t.modelVersionId, t.scoreCutoff, t.policyVersion),
  radar: index('opportunity_batches_radar_current_idx').on(t.workspaceId, t.radarId, t.isCurrent),
  stateCheck: check('opportunity_batches_state_check', sql`
    ${t.status} IN ('building', 'completed', 'failed')
    AND ${t.isCurrent} IN (0, 1)
    AND (${t.isCurrent} = 0 OR (${t.status} = 'completed' AND ${t.materializedAt} IS NOT NULL))
  `),
  countCheck: check('opportunity_batches_count_check', sql`
    ${t.rowCount} >= 0 AND ${t.eligibleCount} >= 0 AND ${t.monetaryRowCount} >= 0
    AND ${t.eligibleCount} <= ${t.rowCount}
    AND ${t.monetaryRowCount} <= ${t.eligibleCount}
  `),
}));

export const opportunityRows = pgTable('opportunity_rows', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  batchId: text('batch_id').notNull(),
  radarId: text('radar_id').notNull(),
  customerId: text('customer_id').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  probability: numeric('probability').notNull(),
  scoreBand: text('score_band').notNull(),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull(),
  predictionWindowEnd: timestamp('prediction_window_end', { withTimezone: true }).notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
  eligibilityState: text('eligibility_state').notNull(),
  expectedOutcomeValue: numeric('expected_outcome_value'),
  expectedRevenue: numeric('expected_revenue'),
  currency: text('currency'),
  valueProvenance: jsonb('value_provenance').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  batchFk: foreignKey({
    name: 'opportunity_rows_batch_fk',
    columns: [t.workspaceId, t.batchId],
    foreignColumns: [opportunityBatches.workspaceId, opportunityBatches.id],
  }).onDelete('restrict'),
  radarFk: foreignKey({
    name: 'opportunity_rows_radar_fk',
    columns: [t.workspaceId, t.radarId],
    foreignColumns: [radars.workspaceId, radars.id],
  }).onDelete('restrict'),
  customerFk: foreignKey({
    name: 'opportunity_rows_customer_fk',
    columns: [t.workspaceId, t.customerId],
    foreignColumns: [customers.workspaceId, customers.id],
  }).onDelete('restrict'),
  modelFk: foreignKey({
    name: 'opportunity_rows_model_fk',
    columns: [t.workspaceId, t.modelVersionId],
    foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id],
  }).onDelete('restrict'),
  one: uniqueIndex('opportunity_rows_batch_customer_uq').on(t.workspaceId, t.batchId, t.customerId),
  probabilityRank: index('opportunity_rows_probability_rank_idx')
    .on(t.workspaceId, t.batchId, t.eligibilityState, t.probability, t.id),
  revenueRank: index('opportunity_rows_revenue_rank_idx')
    .on(t.workspaceId, t.batchId, t.eligibilityState, t.currency, t.expectedRevenue, t.probability, t.id),
  customer: index('opportunity_rows_customer_idx').on(t.workspaceId, t.customerId, t.createdAt),
  probabilityCheck: check('opportunity_rows_probability_check', sql`${t.probability} >= 0 AND ${t.probability} <= 1`),
  bandCheck: check('opportunity_rows_band_check', sql`${t.scoreBand} IN ('high', 'medium', 'low')`),
  valueCheck: check('opportunity_rows_value_check', sql`
    (${t.expectedOutcomeValue} IS NULL AND ${t.expectedRevenue} IS NULL AND ${t.currency} IS NULL)
    OR (${t.expectedOutcomeValue} >= 0 AND ${t.expectedRevenue} >= 0 AND length(trim(${t.currency})) = 3)
  `),
}));

/** Durable export intent/provenance. CSV bytes are streamed, never stored here. */
export const opportunityExports = pgTable('opportunity_exports', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  batchId: text('batch_id').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  actorUserId: text('actor_user_id'),
  correlationId: text('correlation_id').notNull(),
  selection: jsonb('selection').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  rowCount: integer('row_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  batchFk: foreignKey({ name: 'opportunity_exports_batch_fk', columns: [t.workspaceId, t.batchId], foreignColumns: [opportunityBatches.workspaceId, opportunityBatches.id] }).onDelete('restrict'),
  modelFk: foreignKey({ name: 'opportunity_exports_model_fk', columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('restrict'),
  correlationUq: uniqueIndex('opportunity_exports_correlation_uq').on(t.workspaceId, t.correlationId),
  statusCheck: check('opportunity_exports_status_check', sql`${t.status} IN ('pending', 'completed', 'failed') AND ${t.rowCount} >= 0`),
}));

/** Order 100 audience handoff provenance. This is intentionally not a Decision ledger. */
export const opportunityActivations = pgTable('opportunity_activations', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  radarId: text('radar_id').notNull(),
  definitionVersion: integer('definition_version').notNull(),
  modelVersionId: text('model_version_id').notNull(),
  batchId: text('batch_id').notNull(),
  connectionId: text('connection_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  selection: jsonb('selection').$type<Record<string, unknown>>().notNull(),
  counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
  status: text('status').notNull().default('pending'),
  remoteAudienceId: text('remote_audience_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.id] }),
  batchFk: foreignKey({ name: 'opportunity_activations_batch_fk', columns: [t.workspaceId, t.batchId], foreignColumns: [opportunityBatches.workspaceId, opportunityBatches.id] }).onDelete('restrict'),
  definitionFk: foreignKey({ name: 'opportunity_activations_definition_fk', columns: [t.workspaceId, t.radarId, t.definitionVersion], foreignColumns: [radarDefinitionVersions.workspaceId, radarDefinitionVersions.radarId, radarDefinitionVersions.version] }).onDelete('restrict'),
  modelFk: foreignKey({ name: 'opportunity_activations_model_fk', columns: [t.workspaceId, t.modelVersionId], foreignColumns: [radarModelVersions.workspaceId, radarModelVersions.id] }).onDelete('restrict'),
  connectionFk: foreignKey({ name: 'opportunity_activations_connection_fk', columns: [t.workspaceId, t.connectionId], foreignColumns: [connectorConnections.workspaceId, connectorConnections.id] }).onDelete('restrict'),
  idempotencyUq: uniqueIndex('opportunity_activations_idempotency_uq').on(t.workspaceId, t.idempotencyKey),
  statusCheck: check('opportunity_activations_status_check', sql`${t.status} IN ('pending', 'success', 'partial', 'failed')`),
}));
