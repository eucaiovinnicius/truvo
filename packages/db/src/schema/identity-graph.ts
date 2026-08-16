import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { customers, customerIdentifierTypeEnum } from './customer-context';

/**
 * Order 045 — IDENTITY GRAPH V2.
 *
 * Deliberately does NOT touch `identity_links`/`identity_merges` (M8, v1 — see
 * `./identity.ts`): those stay exactly as they are, still written by
 * `IdentityService.identify()`, preserved for backward compatibility (acceptance
 * criterion "existing identity_links/identity_merges preserved").
 *
 * v2's identifier storage is `customers`/`customer_identifiers` (Order 30) — NOT a
 * new table. That table was already built collision-safe: its unique index is
 * `(workspace_id, provider_namespace, identifier_type, identifier_value)`, which is
 * exactly the "workspace + identifier namespace/type + value" uniqueness this order
 * asks for. v1's `identity_links` unique index is `(workspace_id, identifier)` only
 * — no type/namespace dimension — which is the "too coarse" constraint flagged in
 * the order; rather than alter that live v1 constraint (risking a destructive
 * migration), v2 is rooted on the table that already has the right shape.
 *
 * What's genuinely new here: the two things Order 30 + M8 never modeled —
 * an explicit, auditable, resolvable CONFLICT record, and a MERGE EVENT rich enough
 * (evidence + actor + reversal pointer) to support reversal without reconstructing
 * anything from undocumented side effects.
 */

export const IDENTITY_CONFLICT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type IdentityConflictStatus = (typeof IDENTITY_CONFLICT_STATUSES)[number];
export const identityConflictStatusEnum = pgEnum('identity_conflict_status', IDENTITY_CONFLICT_STATUSES);

export const IDENTITY_MERGE_OPERATIONS = ['merge', 'unmerge'] as const;
export type IdentityMergeOperation = (typeof IDENTITY_MERGE_OPERATIONS)[number];
export const identityMergeOperationEnum = pgEnum('identity_merge_operation', IDENTITY_MERGE_OPERATIONS);

export interface IdentityMergeEvidence {
  /** Exact identifier rows moved by this operation — the documented side-effect
   * list an unmerge replays, rather than reconstructing membership heuristically. */
  movedIdentifiers: Array<{
    id: string;
    providerNamespace: string;
    identifierType: string;
    identifierValue: string;
  }>;
  /** Source customer's status immediately before the merge — restored verbatim on unmerge. */
  sourceStatusBeforeMerge?: string;
  /** Present only on 'unmerge' events: identifiers that could NOT be moved back
   * because they were re-attached elsewhere after the original merge (partial
   * reversal is reported explicitly, never silently treated as complete). */
  skippedIdentifierIds?: string[];
  /** Present only on 'unmerge' events: the merge event id being reversed. */
  reversesEventId?: string;
}

export interface IdentityActor {
  type: 'user' | 'system';
  id?: string;
  label?: string;
}

export const identityConflicts = pgTable(
  'identity_conflicts',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    /** Customer that currently owns the identifier (per customer_identifiers) — always a live row, FK-enforced. */
    existingCustomerId: text('existing_customer_id').notNull(),
    /**
     * Customer the caller was trying to attach/merge the identifier into. NOT
     * FK-enforced on purpose: a conflict can legitimately name a customer that was
     * never materialized — e.g. `backfillLegacyIdentity`'s collision preflight
     * deliberately skips creating the `customers` row for a colliding v1 canonical
     * (fail closed, no corruption) while still needing to record WHY it was skipped.
     */
    incomingCustomerId: text('incoming_customer_id').notNull(),
    identifierType: customerIdentifierTypeEnum('identifier_type').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    identifierValue: text('identifier_value').notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sourceNamespace: text('source_namespace').notNull(),
    status: identityConflictStatusEnum('status').notNull().default('open'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolution: jsonb('resolution').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    existingFk: foreignKey({
      name: 'identity_conflicts_existing_customer_fk',
      columns: [t.workspaceId, t.existingCustomerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('cascade'),
    // Idempotent conflict recording: the SAME disagreement (same two customers +
    // same identifier) reported again while still open must not create duplicate rows.
    openUq: uniqueIndex('identity_conflicts_ws_natural_open_uq').on(
      t.workspaceId,
      t.existingCustomerId,
      t.incomingCustomerId,
      t.providerNamespace,
      t.identifierType,
      t.identifierValue,
    ),
    statusIdx: index('identity_conflicts_ws_status_detected_idx').on(t.workspaceId, t.status, t.detectedAt),
    namespaceCheck: check(
      'identity_conflicts_namespace_check',
      sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.sourceNamespace})) > 0 AND length(trim(${t.reason})) > 0`,
    ),
    differentCustomersCheck: check(
      'identity_conflicts_different_customers_check',
      sql`${t.existingCustomerId} <> ${t.incomingCustomerId}`,
    ),
  }),
);

export const identityMergeEvents = pgTable(
  'identity_merge_events',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    operation: identityMergeOperationEnum('operation').notNull(),
    /** merge: loser. unmerge: customer being restored (same as the original merge's source). */
    sourceCustomerId: text('source_customer_id').notNull(),
    /** merge: winner. unmerge: customer being split from (the original merge's target). */
    targetCustomerId: text('target_customer_id').notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<IdentityMergeEvidence>().notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    actor: jsonb('actor').$type<IdentityActor>().notNull(),
    /** Set on a 'merge' event once a later 'unmerge' reverses it — prevents double-unmerge. */
    reversedByEventId: text('reversed_by_event_id'),
    /** Operation/version metadata for audit/rebuild — bumped only on a genuine
     * evidence-shape change, never on ordinary writes. */
    schemaVersion: integer('schema_version').notNull().default(1),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    sourceFk: foreignKey({
      name: 'identity_merge_events_source_customer_fk',
      columns: [t.workspaceId, t.sourceCustomerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('cascade'),
    targetFk: foreignKey({
      name: 'identity_merge_events_target_customer_fk',
      columns: [t.workspaceId, t.targetCustomerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('cascade'),
    targetIdx: index('identity_merge_events_ws_target_at_idx').on(t.workspaceId, t.targetCustomerId, t.at),
    sourceIdx: index('identity_merge_events_ws_source_at_idx').on(t.workspaceId, t.sourceCustomerId, t.at),
    namespaceCheck: check(
      'identity_merge_events_namespace_check',
      sql`length(trim(${t.reason})) > 0 AND length(trim(${t.sourceNamespace})) > 0`,
    ),
    differentCustomersCheck: check(
      'identity_merge_events_different_customers_check',
      sql`${t.sourceCustomerId} <> ${t.targetCustomerId}`,
    ),
  }),
);

export type IdentityConflict = typeof identityConflicts.$inferSelect;
export type IdentityMergeEvent = typeof identityMergeEvents.$inferSelect;
