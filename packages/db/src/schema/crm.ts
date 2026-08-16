import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { connectorConnections } from './connectors';

/**
 * Order 061 — provider-neutral CRM representation. No existing table could hold a
 * B2B company/account or a commercial deal/opportunity (confirmed by inspection —
 * same reasoning as Order 060's `commerce.ts`: additive, not a redesign, and
 * nothing here is HubSpot-specific — `provider_namespace` namespaces the source
 * exactly like `customer_identifiers`/`commerce_orders` already do, so a future
 * Salesforce/Pipedrive CRM source can write into the SAME tables).
 *
 * `crm_accounts`/`crm_deals` are DELIBERATELY not `customers` rows — Identity
 * Graph v2 (`customers`/`customer_identifiers`) resolves PEOPLE via strong
 * personal identifiers (email/phone/user_id); a company is not a person and must
 * never enter that merge/suppression machinery. Contact→Customer stays the ONLY
 * bridge into Identity Graph v2 (via the existing `customer_identifiers`).
 *
 * `crm_associations` is a single generic edge table (not per-pair tables) because
 * HubSpot's own association model is already object-type-agnostic
 * (contact↔company, contact↔deal, company↔deal) — one edge shape, `from`/`to`
 * object type + LOCAL id (customers.id for a contact, crm_accounts.id / crm_deals.id
 * otherwise), keyed by a natural unique index so writing the SAME association
 * again (in any page order, from either side's sync) is a no-op — this is what
 * makes "associations converge independently of page order" (Order 061 §3) true
 * without extra bookkeeping.
 *
 * `deleted_at` (Order 061 association+contract closure) makes edge removal
 * explicit/auditable rather than a hard delete — a full-object reconciliation
 * sync reports the CURRENT complete association set for one (fromObject,
 * toObjectType) pair; an edge previously active but now absent from that set is
 * TOMBSTONED (`deleted_at` set), never dropped, preserving the workspace+provider
 * provenance/history. `observed_at` doubles as the out-of-order guard: a stale
 * reconciliation (older `observed_at` than what's already recorded for that
 * group) is rejected wholesale rather than partially applied.
 */
export const crmAccounts = pgTable(
  'crm_accounts',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    providerObjectId: text('provider_object_id').notNull(),
    name: text('name'),
    /** Only the properties the workspace's explicit config selected — never an
     * indiscriminate copy of every custom property (Order 061 §2). */
    traits: jsonb('traits').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sourceNamespace: text('source_namespace').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    /** Order 061 §6/§9 "deletion/restoration behavior explicit" — set when the
     * PROVIDER reports this record deleted (e.g. `company.deletion`); cleared on
     * `company.restore`. Explicit and visible, not a cascading multi-store erasure
     * (that stays Order 55's `DataLifecycleService` — see `contact.privacyDeletion`
     * handling in `hubspot.adapter.ts`, which suppresses the identifier instead). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'crm_accounts_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('crm_accounts_ws_provider_object_uq').on(t.workspaceId, t.providerNamespace, t.providerObjectId),
    namespaceCheck: check('crm_accounts_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerObjectId})) > 0`),
  }),
);

export const crmDeals = pgTable(
  'crm_deals',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    providerObjectId: text('provider_object_id').notNull(),
    name: text('name'),
    amount: numeric('amount'),
    currency: text('currency'),
    pipeline: text('pipeline'),
    stage: text('stage'),
    status: text('status'),
    dealTimestamp: timestamp('deal_timestamp', { withTimezone: true }).notNull(),
    /** Only the properties the workspace's explicit config selected. */
    traits: jsonb('traits').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sourceNamespace: text('source_namespace').notNull(),
    /** Order 061 §6/§9 — see `crm_accounts.deleted_at` doc comment; same semantics. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'crm_deals_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('crm_deals_ws_provider_object_uq').on(t.workspaceId, t.providerNamespace, t.providerObjectId),
    stageIdx: index('crm_deals_ws_stage_idx').on(t.workspaceId, t.stage),
    namespaceCheck: check('crm_deals_namespace_check', sql`length(trim(${t.providerNamespace})) > 0 AND length(trim(${t.providerObjectId})) > 0`),
  }),
);

export const CRM_OBJECT_TYPES = ['contact', 'company', 'deal'] as const;
export type CrmObjectType = (typeof CRM_OBJECT_TYPES)[number];

export const crmAssociations = pgTable(
  'crm_associations',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    /** 'contact' resolves to `customers.id`; 'company'/'deal' resolve to
     * `crm_accounts.id`/`crm_deals.id` — deliberately NOT a DB-level FK (the
     * target table varies by type), enforced by `CrmWriteService` at write time. */
    fromObjectType: text('from_object_type').notNull(),
    fromObjectId: text('from_object_id').notNull(),
    toObjectType: text('to_object_type').notNull(),
    toObjectId: text('to_object_id').notNull(),
    associationType: text('association_type').notNull(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'crm_associations_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('crm_associations_ws_natural_uq').on(t.workspaceId, t.fromObjectType, t.fromObjectId, t.toObjectType, t.toObjectId, t.associationType),
    toIdx: index('crm_associations_ws_to_idx').on(t.workspaceId, t.toObjectType, t.toObjectId),
    groupIdx: index('crm_associations_ws_from_group_idx').on(t.workspaceId, t.fromObjectType, t.fromObjectId, t.toObjectType),
    typeCheck: check('crm_associations_type_check', sql`${t.fromObjectType} IN ('contact','company','deal') AND ${t.toObjectType} IN ('contact','company','deal')`),
  }),
);

export type CrmAccount = typeof crmAccounts.$inferSelect;
export type CrmDeal = typeof crmDeals.$inferSelect;
export type CrmAssociation = typeof crmAssociations.$inferSelect;
