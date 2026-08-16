import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { backfillStatusEnum } from './customer-context';

/**
 * Order 050 — CONNECTOR FRAMEWORK.
 *
 * Additive, sitting ALONGSIDE (never replacing) the existing inbound `integrations`
 * (M4, packages/db/src/schema/integrations.ts) and outbound `integration_out_configs`
 * (M9, packages/db/src/schema/integrations-out.ts). Those tables keep serving their
 * existing `/v1/integrations` / `/v1/integrations-out` flows completely unchanged —
 * same precedent as Order 40 (`customer_outcomes` next to `outcome_definitions`) and
 * Order 45 (`customer_identifiers` next to `identity_links`): a new, purpose-built
 * table for a genuinely new lifecycle model, bridged forward rather than retrofitted
 * onto shipped tables with incompatible enums/columns.
 *
 * `connector_sync_runs` doubles as the webhook-delivery idempotency ledger (kind =
 * 'webhook_ingest', idempotencyKey = the provider's delivery/event id) instead of a
 * separate table — "duplicate delivery must be harmless" falls out of the same
 * unique index that makes backfill/incremental retries idempotent.
 */

export const CONNECTOR_ROLES = ['source', 'destination', 'bidirectional'] as const;
export type ConnectorRole = (typeof CONNECTOR_ROLES)[number];
export const connectorRoleEnum = pgEnum('connector_role', CONNECTOR_ROLES);

/** Order's own literal progression (draft → authorizing → connected → syncing →
 * healthy/degraded/error → disconnected). `credential_status` below is the
 * SEPARATE, narrower signal that only credential test/refresh may write to —
 * a sync failure changes `lifecycle_state`, never `credential_status`. */
export const CONNECTOR_LIFECYCLE_STATES = [
  'draft',
  'authorizing',
  'connected',
  'syncing',
  'healthy',
  'degraded',
  'error',
  'disconnected',
] as const;
export type ConnectorLifecycleState = (typeof CONNECTOR_LIFECYCLE_STATES)[number];
export const connectorLifecycleStateEnum = pgEnum('connector_lifecycle_state', CONNECTOR_LIFECYCLE_STATES);

export const CONNECTOR_CREDENTIAL_STATUSES = ['unset', 'valid', 'invalid', 'expired'] as const;
export type ConnectorCredentialStatus = (typeof CONNECTOR_CREDENTIAL_STATUSES)[number];
export const connectorCredentialStatusEnum = pgEnum('connector_credential_status', CONNECTOR_CREDENTIAL_STATUSES);

export const CONNECTOR_SYNC_RUN_KINDS = ['backfill', 'incremental', 'webhook_ingest'] as const;
export type ConnectorSyncRunKind = (typeof CONNECTOR_SYNC_RUN_KINDS)[number];
export const connectorSyncRunKindEnum = pgEnum('connector_sync_run_kind', CONNECTOR_SYNC_RUN_KINDS);

export const CONNECTOR_SYNC_RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'rate_limited'] as const;
export type ConnectorSyncRunStatus = (typeof CONNECTOR_SYNC_RUN_STATUSES)[number];
export const connectorSyncRunStatusEnum = pgEnum('connector_sync_run_status', CONNECTOR_SYNC_RUN_STATUSES);

export const CONNECTOR_FAILURE_KINDS = ['transient', 'permanent'] as const;
export type ConnectorFailureKind = (typeof CONNECTOR_FAILURE_KINDS)[number];
export const connectorFailureKindEnum = pgEnum('connector_failure_kind', CONNECTOR_FAILURE_KINDS);

export const CONNECTOR_DESTINATION_WRITE_STATUSES = ['sent', 'failed', 'skipped_duplicate'] as const;
export type ConnectorDestinationWriteStatus = (typeof CONNECTOR_DESTINATION_WRITE_STATUSES)[number];
export const connectorDestinationWriteStatusEnum = pgEnum('connector_destination_write_status', CONNECTOR_DESTINATION_WRITE_STATUSES);

export const connectorConnections = pgTable(
  'connector_connections',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    /** Stable key matching a registered `ConnectorDefinition.provider` — free text,
     * not an enum, so new providers never require a migration (mirrors `source_namespace`). */
    provider: text('provider').notNull(),
    role: connectorRoleEnum('role').notNull(),
    displayName: text('display_name').notNull(),
    lifecycleState: connectorLifecycleStateEnum('lifecycle_state').notNull().default('draft'),
    credentialStatus: connectorCredentialStatusEnum('credential_status').notNull().default('unset'),
    /** Same AES-256-GCM blob format as M4/M9 (`v1.<iv>.<tag>.<ct>`) — null while in 'draft'. */
    credentialsEncrypted: text('credentials_encrypted'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Subset of the definition's capabilities enabled for THIS connection. */
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastError: text('last_error'),
    lastCredentialCheckAt: timestamp('last_credential_check_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    workspaceIdx: index('connector_connections_ws_provider_idx').on(t.workspaceId, t.provider),
    stateIdx: index('connector_connections_ws_lifecycle_idx').on(t.workspaceId, t.lifecycleState),
    providerCheck: check('connector_connections_provider_check', sql`length(trim(${t.provider})) > 0 AND length(trim(${t.displayName})) > 0`),
  }),
);

export const connectorSyncCheckpoints = pgTable(
  'connector_sync_checkpoints',
  {
    workspaceId: text('workspace_id').notNull(),
    connectionId: text('connection_id').notNull(),
    /** Provider-defined stream name (e.g. 'orders', 'customers') — 'default' when the provider has only one. */
    streamKey: text('stream_key').notNull(),
    /** Opaque provider cursor/high-water mark — the framework never interprets its shape. */
    cursor: text('cursor'),
    status: backfillStatusEnum('status').notNull().default('pending'),
    processedCount: integer('processed_count').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'connector_sync_checkpoints_pk', columns: [t.workspaceId, t.connectionId, t.streamKey] }),
    connectionFk: foreignKey({
      name: 'connector_sync_checkpoints_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    streamCheck: check('connector_sync_checkpoints_stream_check', sql`length(trim(${t.streamKey})) > 0`),
  }),
);

export const connectorSyncRuns = pgTable(
  'connector_sync_runs',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    kind: connectorSyncRunKindEnum('kind').notNull(),
    /** Backfill/incremental: a deterministic key per checkpoint boundary. Webhook:
     * the provider's own delivery/event id. Unique per connection → replay-safe. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: connectorSyncRunStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    recordsRead: integer('records_read').notNull().default(0),
    recordsWritten: integer('records_written').notNull().default(0),
    errorKind: connectorFailureKindEnum('error_kind'),
    errorReason: text('error_reason'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    /** Cursor snapshot the run started from / advances to — `checkpointAfter` is
     * only meaningful once `status = 'succeeded'` (checkpoint advances only past
     * a successfully processed boundary). */
    checkpointBefore: text('checkpoint_before'),
    checkpointAfter: text('checkpoint_after'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'connector_sync_runs_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    idempotencyUq: uniqueIndex('connector_sync_runs_ws_connection_idempotency_uq').on(t.workspaceId, t.connectionId, t.idempotencyKey),
    retryIdx: index('connector_sync_runs_ws_status_retry_idx').on(t.workspaceId, t.status, t.nextRetryAt),
    idempotencyCheck: check('connector_sync_runs_idempotency_check', sql`length(trim(${t.idempotencyKey})) > 0`),
  }),
);

export const connectorDestinationWrites = pgTable(
  'connector_destination_writes',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: text('correlation_id').notNull(),
    /** Provider-neutral write kind (e.g. 'profile_upsert', 'audience_add') — free text, namespaced by convention. */
    kind: text('kind').notNull(),
    status: connectorDestinationWriteStatusEnum('status').notNull(),
    externalResultId: text('external_result_id'),
    retryable: boolean('retryable'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    connectionFk: foreignKey({
      name: 'connector_destination_writes_connection_fk',
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connectorConnections.workspaceId, connectorConnections.id],
    }).onDelete('cascade'),
    idempotencyUq: uniqueIndex('connector_destination_writes_ws_connection_idempotency_uq').on(t.workspaceId, t.connectionId, t.idempotencyKey),
    monitorIdx: index('connector_destination_writes_ws_connection_created_idx').on(t.workspaceId, t.connectionId, t.createdAt),
    idempotencyCheck: check('connector_destination_writes_idempotency_check', sql`length(trim(${t.idempotencyKey})) > 0 AND length(trim(${t.correlationId})) > 0 AND length(trim(${t.kind})) > 0`),
  }),
);

export type ConnectorConnectionRow = typeof connectorConnections.$inferSelect;
export type ConnectorSyncCheckpointRow = typeof connectorSyncCheckpoints.$inferSelect;
export type ConnectorSyncRunRow = typeof connectorSyncRuns.$inferSelect;
export type ConnectorDestinationWriteRow = typeof connectorDestinationWrites.$inferSelect;
