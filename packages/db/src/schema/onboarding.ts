import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './auth';

export const ONBOARDING_PATHS = ['ecommerce', 'saas', 'custom'] as const;
export const ONBOARDING_STATES = ['not_started', 'in_progress', 'waiting_for_connection', 'syncing', 'waiting_for_data', 'data_detected', 'readiness_available', 'radar_in_progress', 'completed', 'blocked'] as const;

/** Narrow workspace-owned setup state. Canonical connector/readiness/Radar facts
 * remain in their existing domains; this row only records guided-flow progress. */
export const onboardingProgress = pgTable('onboarding_progress', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('not_started'), selectedPath: text('selected_path'),
  currentStep: text('current_step').notNull().default('workspace_basics'), connectionId: text('connection_id'), sourceStatus: text('source_status'),
  startedAt: timestamp('started_at', { withTimezone: true }), healthyContextAt: timestamp('healthy_context_at', { withTimezone: true }), dataVerifiedAt: timestamp('data_verified_at', { withTimezone: true }), readinessViewedAt: timestamp('readiness_viewed_at', { withTimezone: true }),
  firstRadarInitiatedAt: timestamp('first_radar_initiated_at', { withTimezone: true }), firstRadarCreatedAt: timestamp('first_radar_created_at', { withTimezone: true }), firstRadarId: text('first_radar_id'), radarIdempotencyKey: text('radar_idempotency_key'), completedAt: timestamp('completed_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'), lastErrorRemediation: text('last_error_remediation'), version: integer('version').notNull().default(1), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statusCheck: check('onboarding_progress_status_check', sql`${table.status} in ('not_started','in_progress','waiting_for_connection','syncing','waiting_for_data','data_detected','readiness_available','radar_in_progress','completed','blocked')`),
  pathCheck: check('onboarding_progress_path_check', sql`${table.selectedPath} is null or ${table.selectedPath} in ('ecommerce','saas','custom')`),
  lookup: index('onboarding_progress_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
}));

export const onboardingMilestones = pgTable('onboarding_milestones', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  milestone: text('milestone').notNull(), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  milestoneUnique: uniqueIndex('onboarding_milestones_workspace_milestone_uq').on(table.workspaceId, table.milestone), timeline: index('onboarding_milestones_workspace_time_idx').on(table.workspaceId, table.occurredAt),
  milestoneCheck: check('onboarding_milestones_name_check', sql`${table.milestone} in ('onboarding_started','onboarding_path_selected','context_connection_started','context_connection_succeeded','context_connection_failed','incoming_data_verified','readiness_viewed','first_radar_initiated','first_radar_created','onboarding_completed')`),
}));
