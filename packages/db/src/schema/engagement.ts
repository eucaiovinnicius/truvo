import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { connectorConnections } from './connectors';
import { customers } from './customer-context';

/**
 * Order 063 — provider-attributed canonical ENGAGEMENT observations (email/SMS
 * delivery, open, click, bounce, unsubscribe, plus Truvo's own custom event read
 * back through the normal source path). Additive, sits alongside billing-context
 * (Order 062) and commerce (Order 060) as its own purpose-built table — an
 * engagement event is an immutable append-only FACT, never upserted-in-place the
 * way a mutable billing/commerce row is, so there is no out-of-order guard here:
 * `provider_event_id` is the sole natural key, insert-once (`onConflictDoNothing`),
 * never updated.
 */
export const ENGAGEMENT_KINDS = ['received', 'delivery', 'opened', 'clicked', 'bounced', 'unsubscribed', 'marked_spam', 'other'] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];
export const engagementKindEnum = pgEnum('engagement_kind', ENGAGEMENT_KINDS);

export const engagementEvents = pgTable(
  'engagement_events',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    /** Null when the engagement record's identity did not resolve to a canonical
     * customer (e.g. an anonymous/never-synced profile) — durable but unattached,
     * same pattern as an unlinked commerce order (Order 060 §8). */
    customerId: text('customer_id'),
    providerNamespace: text('provider_namespace').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    metricName: text('metric_name').notNull(),
    engagementKind: engagementKindEnum('engagement_kind').notNull(),
    campaignId: text('campaign_id'),
    flowId: text('flow_id'),
    /** Set only when deterministic correlation evidence exists (Order 063 §7) —
     * plain text, no FK: it references `connector_destination_writes.correlation_id`
     * conceptually, but that table is keyed by (workspace, connection, idempotency),
     * not a single-column PK, so this stays a lookup value, not an enforced FK,
     * matching the existing no-FK-across-conceptual-domains convention. */
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'engagement_events_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    customerFk: foreignKey({
      name: 'engagement_events_customer_fk',
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete('set null'),
    naturalUq: uniqueIndex('engagement_events_ws_namespace_event_uq').on(t.workspaceId, t.providerNamespace, t.providerEventId),
    customerIdx: index('engagement_events_ws_customer_occurred_idx').on(t.workspaceId, t.customerId, t.occurredAt),
    correlationIdx: index('engagement_events_ws_correlation_idx').on(t.workspaceId, t.correlationId),
    namespaceCheck: check('engagement_events_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerEventId})) > 0 AND length(trim(${t.metricName})) > 0`),
  }),
);

export type EngagementEvent = typeof engagementEvents.$inferSelect;
