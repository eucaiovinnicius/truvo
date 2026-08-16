import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { customerIdentifierTypeEnum } from './customer-context';

/**
 * Order 055 §3 — SUPPRESSION / TOMBSTONE AGAINST RECONSTRUCTION.
 *
 * A completed subject deletion suppresses the identifier(s) that resolved to it —
 * one row per (workspace, provider_namespace, identifier_type, identifier_value).
 * Consulted by every write path that could otherwise re-attach/re-create canonical
 * identity for that identifier: `CustomerContextService.synchronizeLegacyIdentity`
 * (the v1 identify() bridge), `IdentityGraphService.attachIdentifier`/
 * `resolveOrCreateCustomer` (v2, and transitively the Connector Framework's
 * `CanonicalMappingService`, which routes through those same methods).
 *
 * Reactivation is a distinct, explicit, audited write (`reactivatedAt`/`reactivatedBy`)
 * — never inferred from a replay simply "not finding" a suppression row wouldn't be
 * enough on its own to prove the difference; the row's OWN reactivation fields are
 * the durable, auditable record of an authorized un-suppression.
 */
export const identitySuppressions = pgTable(
  'identity_suppressions',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    providerNamespace: text('provider_namespace').notNull(),
    identifierType: customerIdentifierTypeEnum('identifier_type').notNull(),
    identifierValue: text('identifier_value').notNull(),
    reason: text('reason').notNull(),
    /** The data_lifecycle_requests.id that caused this suppression, when applicable. Plain text — matches the relaxed no-FK convention already used across workspace-scoped tables (workspace_id itself is never FK'd either). */
    sourceRequestId: text('source_request_id'),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }).notNull().defaultNow(),
    reactivatedAt: timestamp('reactivated_at', { withTimezone: true }),
    reactivatedBy: text('reactivated_by'),
    reactivationReason: text('reactivation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    naturalUq: uniqueIndex('identity_suppressions_ws_natural_uq').on(t.workspaceId, t.providerNamespace, t.identifierType, t.identifierValue),
    activeIdx: index('identity_suppressions_ws_active_idx').on(t.workspaceId, t.reactivatedAt),
    reasonCheck: check('identity_suppressions_reason_check', sql`length(trim(${t.reason})) > 0 AND length(trim(${t.providerNamespace})) > 0`),
  }),
);

export type IdentitySuppression = typeof identitySuppressions.$inferSelect;
