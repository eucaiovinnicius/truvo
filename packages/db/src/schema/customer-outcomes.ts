import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { customers, outcomeDefinitions, type ContextProvenance } from './customer-context';

/**
 * Order 040 — observed/completed outcomes (the event→canonical projection's economic
 * record). `outcome_definitions` (Order 30) is only the CATALOG entry (what an outcome
 * means); this table is each OBSERVATION of it happening for a customer. Additive:
 * does not touch ClickHouse event history, which remains the source record.
 *
 * `dedupe_key` = order_id when the projection rule carries one, else the source
 * event_id. The unique index on (workspace, namespace, key, dedupe_key) plus a
 * deterministic row id (derived from the same triple) make replay/retry of the same
 * event idempotent — a duplicate projection attempt hits the constraint and is a
 * no-op (`onConflictDoNothing`), never a second economic record for the same event.
 */
export const customerOutcomes = pgTable(
  'customer_outcomes',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    customerId: text('customer_id').notNull(),
    outcomeDefinitionId: text('outcome_definition_id').notNull(),
    outcomeNamespace: text('outcome_namespace').notNull(),
    outcomeKey: text('outcome_key').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    eventId: text('event_id').notNull(),
    value: numeric('value'),
    currency: text('currency'),
    sourceNamespace: text('source_namespace').notNull(),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    customerFk: foreignKey({
      name: 'customer_outcomes_customer_fk',
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('cascade'),
    definitionFk: foreignKey({
      name: 'customer_outcomes_definition_fk',
      columns: [t.workspaceId, t.outcomeDefinitionId],
      foreignColumns: [outcomeDefinitions.workspaceId, outcomeDefinitions.id],
    }).onDelete('cascade'),
    dedupeUq: uniqueIndex('customer_outcomes_ws_namespace_key_dedupe_uq').on(
      t.workspaceId,
      t.outcomeNamespace,
      t.outcomeKey,
      t.dedupeKey,
    ),
    customerIdx: index('customer_outcomes_ws_customer_observed_idx').on(t.workspaceId, t.customerId, t.observedAt),
    namespaceCheck: check(
      'customer_outcomes_namespace_check',
      sql`length(trim(${t.outcomeNamespace})) > 0 AND length(trim(${t.outcomeKey})) > 0 AND length(trim(${t.sourceNamespace})) > 0 AND length(trim(${t.dedupeKey})) > 0`,
    ),
  }),
);

export type CustomerOutcome = typeof customerOutcomes.$inferSelect;
