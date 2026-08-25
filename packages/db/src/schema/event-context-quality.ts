import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const qualityIssues = pgTable('quality_issues', {
  workspaceId: text('workspace_id').notNull(), id: text('id').notNull(), stableKey: text('stable_key').notNull(),
  category: text('category').notNull(), severity: text('severity').notNull(), status: text('status').notNull().default('active'),
  sourceNamespace: text('source_namespace'), connectionId: text('connection_id'), streamKey: text('stream_key'),
  entityType: text('entity_type'), entityId: text('entity_id'), eventName: text('event_name'),
  sampleContext: jsonb('sample_context').$type<Record<string, unknown>>(), actionCode: text('action_code'), details: jsonb('details').$type<Record<string, unknown>>(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(), lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  occurrenceCount: integer('occurrence_count').notNull().default(1), resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.id] }), stableKeyUq: uniqueIndex('quality_issues_ws_stable_key_uq').on(t.workspaceId, t.stableKey), workspaceStatusIdx: index('quality_issues_ws_status_idx').on(t.workspaceId, t.status) }));

export const qualityEvaluations = pgTable('quality_evaluations', {
  workspaceId: text('workspace_id').primaryKey(), evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  dataHealthScore: integer('data_health_score').notNull().default(100), dataHealthStatus: text('data_health_status').notNull().default('healthy'),
  contextCoverageScore: integer('context_coverage_score').notNull().default(0), identityCoverage: integer('identity_coverage').notNull().default(0),
  dimensions: jsonb('dimensions').$type<Record<string, unknown>>().notNull().default({}), sourceFreshness: jsonb('source_freshness').$type<Record<string, unknown>>().notNull().default({}), duplicateSummary: jsonb('duplicate_summary').$type<Record<string, unknown>>().notNull().default({}),
  criticalCount: integer('critical_count').notNull().default(0), warningsCount: integer('warnings_count').notNull().default(0), radarReadiness: jsonb('radar_readiness').$type<Record<string, unknown>>().notNull().default({}), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type QualityIssue = typeof qualityIssues.$inferSelect;
export type QualityEvaluation = typeof qualityEvaluations.$inferSelect;
