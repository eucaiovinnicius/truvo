import { sql } from 'drizzle-orm';
import {
  boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable,
  primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Additive Truvo 4.x state/config model. Event history remains in ClickHouse. */
export const CUSTOMER_STATUSES = ['anonymous', 'identified', 'merged'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const customerStatusEnum = pgEnum('customer_status', CUSTOMER_STATUSES);

export const CUSTOMER_IDENTIFIER_TYPES = [
  'click_id', 'anonymous_id', 'user_id', 'email_hash', 'phone_hash', 'order_id', 'external_id',
] as const;
export type CustomerIdentifierType = (typeof CUSTOMER_IDENTIFIER_TYPES)[number];
export const customerIdentifierTypeEnum = pgEnum('customer_identifier_type', CUSTOMER_IDENTIFIER_TYPES);

export const CUSTOMER_TRAIT_VALUE_TYPES = ['string', 'number', 'boolean', 'datetime', 'json'] as const;
export type CustomerTraitValueType = (typeof CUSTOMER_TRAIT_VALUE_TYPES)[number];
export const customerTraitValueTypeEnum = pgEnum('customer_trait_value_type', CUSTOMER_TRAIT_VALUE_TYPES);

export const OUTCOME_DEFINITION_KINDS = ['event', 'trait'] as const;
export type OutcomeDefinitionKind = (typeof OUTCOME_DEFINITION_KINDS)[number];
export const outcomeDefinitionKindEnum = pgEnum('outcome_definition_kind', OUTCOME_DEFINITION_KINDS);

export const BACKFILL_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export const backfillStatusEnum = pgEnum('customer_context_backfill_status', BACKFILL_STATUSES);

export interface ContextProvenance {
  source_record_id?: string;
  source_observed_at?: string;
  imported_by?: string;
  metadata?: Record<string, unknown>;
}

export interface OutcomeDefinitionConfig {
  event_name?: string;
  trait_namespace?: string;
  trait_key?: string;
  operator?: 'exists' | 'equals' | 'gt' | 'gte' | 'lt' | 'lte';
  expected_value?: unknown;
  value_property?: string;
  currency_property?: string;
}

export const customers = pgTable(
  'customers',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    legacyCanonicalId: text('legacy_canonical_id'),
    status: customerStatusEnum('status').notNull().default('anonymous'),
    mergedIntoCustomerId: text('merged_into_customer_id'),
    sourceNamespace: text('source_namespace').notNull(),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    legacyCanonicalUq: uniqueIndex('customers_ws_legacy_canonical_uq').on(t.workspaceId, t.legacyCanonicalId),
    activeIdx: index('customers_ws_status_last_seen_idx').on(t.workspaceId, t.status, t.lastSeenAt),
    sourceCheck: check('customers_source_namespace_check', sql`length(trim(${t.sourceNamespace})) > 0`),
    mergeCheck: check('customers_merge_target_check', sql`(${t.status} = 'merged' AND ${t.mergedIntoCustomerId} IS NOT NULL) OR (${t.status} <> 'merged' AND ${t.mergedIntoCustomerId} IS NULL)`),
    seenCheck: check('customers_seen_order_check', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  }),
);

export const customerIdentifiers = pgTable(
  'customer_identifiers',
  {
    workspaceId: text('workspace_id').notNull(), id: text('id').notNull(),
    customerId: text('customer_id').notNull(),
    identifierType: customerIdentifierTypeEnum('identifier_type').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    identifierValue: text('identifier_value').notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    customerFk: foreignKey({ name: 'customer_identifiers_customer_fk', columns: [t.workspaceId, t.customerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('cascade'),
    valueUq: uniqueIndex('customer_identifiers_ws_provider_type_value_uq').on(t.workspaceId, t.providerNamespace, t.identifierType, t.identifierValue),
    customerIdx: index('customer_identifiers_ws_customer_idx').on(t.workspaceId, t.customerId),
    providerCheck: check('customer_identifiers_provider_namespace_check', sql`length(trim(${t.providerNamespace})) > 0`),
    sourceCheck: check('customer_identifiers_source_namespace_check', sql`length(trim(${t.sourceNamespace})) > 0`),
    seenCheck: check('customer_identifiers_seen_order_check', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  }),
);

export const customerTraits = pgTable(
  'customer_traits',
  {
    workspaceId: text('workspace_id').notNull(), id: text('id').notNull(),
    customerId: text('customer_id').notNull(), traitNamespace: text('trait_namespace').notNull(),
    traitKey: text('trait_key').notNull(), valueType: customerTraitValueTypeEnum('value_type').notNull(),
    value: jsonb('value').$type<unknown>().notNull(), sourceNamespace: text('source_namespace').notNull(),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    customerFk: foreignKey({ name: 'customer_traits_customer_fk', columns: [t.workspaceId, t.customerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('cascade'),
    currentUq: uniqueIndex('customer_traits_ws_customer_namespace_key_uq').on(t.workspaceId, t.customerId, t.traitNamespace, t.traitKey),
    activeIdx: index('customer_traits_ws_customer_observed_idx').on(t.workspaceId, t.customerId, t.observedAt),
    namespaceCheck: check('customer_traits_namespace_check', sql`length(trim(${t.traitNamespace})) > 0 AND length(trim(${t.sourceNamespace})) > 0 AND length(trim(${t.traitKey})) > 0`),
  }),
);

export const customerRelationships = pgTable(
  'customer_relationships',
  {
    workspaceId: text('workspace_id').notNull(), id: text('id').notNull(),
    fromCustomerId: text('from_customer_id').notNull(), toCustomerId: text('to_customer_id').notNull(),
    relationshipNamespace: text('relationship_namespace').notNull(), relationshipType: text('relationship_type').notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }), validUntil: timestamp('valid_until', { withTimezone: true }),
    retentionUntil: timestamp('retention_until', { withTimezone: true }), deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    fromFk: foreignKey({ name: 'customer_relationships_from_customer_fk', columns: [t.workspaceId, t.fromCustomerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('cascade'),
    toFk: foreignKey({ name: 'customer_relationships_to_customer_fk', columns: [t.workspaceId, t.toCustomerId], foreignColumns: [customers.workspaceId, customers.id] }).onDelete('cascade'),
    naturalUq: uniqueIndex('customer_relationships_ws_natural_uq').on(t.workspaceId, t.fromCustomerId, t.toCustomerId, t.relationshipNamespace, t.relationshipType, t.sourceNamespace),
    toIdx: index('customer_relationships_ws_to_idx').on(t.workspaceId, t.toCustomerId),
    namespaceCheck: check('customer_relationships_namespace_check', sql`length(trim(${t.relationshipNamespace})) > 0 AND length(trim(${t.relationshipType})) > 0 AND length(trim(${t.sourceNamespace})) > 0`),
    selfCheck: check('customer_relationships_not_self_check', sql`${t.fromCustomerId} <> ${t.toCustomerId}`),
  }),
);

export const outcomeDefinitions = pgTable(
  'outcome_definitions',
  {
    workspaceId: text('workspace_id').notNull(), id: text('id').notNull(),
    outcomeNamespace: text('outcome_namespace').notNull(), outcomeKey: text('outcome_key').notNull(),
    name: text('name').notNull(), description: text('description'), kind: outcomeDefinitionKindEnum('kind').notNull(),
    definition: jsonb('definition').$type<OutcomeDefinitionConfig>().notNull(), sourceNamespace: text('source_namespace').notNull(),
    provenance: jsonb('provenance').$type<ContextProvenance>().notNull().default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true), retentionUntil: timestamp('retention_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    naturalUq: uniqueIndex('outcome_definitions_ws_namespace_key_uq').on(t.workspaceId, t.outcomeNamespace, t.outcomeKey),
    activeIdx: index('outcome_definitions_ws_active_idx').on(t.workspaceId, t.isActive),
    namespaceCheck: check('outcome_definitions_namespace_check', sql`length(trim(${t.outcomeNamespace})) > 0 AND length(trim(${t.outcomeKey})) > 0 AND length(trim(${t.sourceNamespace})) > 0`),
  }),
);

/** Durable workspace-scoped cursor for the v3.2 profile/identity backfill. */
export const customerContextBackfillCheckpoints = pgTable(
  'customer_context_backfill_checkpoints',
  {
    workspaceId: text('workspace_id').notNull(), backfillKey: text('backfill_key').notNull(),
    status: backfillStatusEnum('status').notNull().default('pending'), cursor: text('cursor'),
    processedCount: integer('processed_count').notNull().default(0), lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'customer_context_backfill_checkpoint_pk', columns: [t.workspaceId, t.backfillKey] }),
    statusIdx: index('customer_context_backfill_status_idx').on(t.status, t.updatedAt),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type CustomerIdentifier = typeof customerIdentifiers.$inferSelect;
export type CustomerTrait = typeof customerTraits.$inferSelect;
export type CustomerRelationship = typeof customerRelationships.$inferSelect;
export type OutcomeDefinition = typeof outcomeDefinitions.$inferSelect;
