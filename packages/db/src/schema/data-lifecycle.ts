import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { backfillStatusEnum } from './customer-context';

/**
 * Order 035 §5 — DATA LIFECYCLE FOUNDATION. Rastreia pedidos de export/deleção de
 * titular e deleção de workspace: policy + contrato + orquestração, workspace-
 * -scoped, retry-safe e auditável (via `audit_log`). NÃO é o motor de erasure
 * cross-store completo (Order 55) — aqui a execução mínima é: dados canônicos
 * (customer-context, Postgres) são tombstoned (`deleted_at`); dados comportamentais
 * (ClickHouse events/touchpoints) ficam REFERENCIADOS, não apagados aqui — ver
 * `docs/exec/DATA_LIFECYCLE_LINEAGE.md` para a classificação delete/anonymize/
 * reconstruct de cada store atual.
 *
 * `status` reusa `backfillStatusEnum` (mesmo conjunto pending/running/completed/
 * failed já usado por `customer_context_backfill_checkpoints`) — reuso deliberado
 * em vez de um enum paralelo idêntico.
 */
export const DATA_LIFECYCLE_KINDS = ['subject_export', 'subject_deletion', 'workspace_deletion'] as const;
export type DataLifecycleKind = (typeof DATA_LIFECYCLE_KINDS)[number];
export const dataLifecycleKindEnum = pgEnum('data_lifecycle_kind', DATA_LIFECYCLE_KINDS);

export interface DataLifecycleResultRef {
  /** Contagens/resumo, NUNCA payload de PII em claro. */
  [key: string]: unknown;
}

export const dataLifecycleRequests = pgTable(
  'data_lifecycle_requests',
  {
    id: text('id').primaryKey(), // dlr_<ulid>
    workspaceId: text('workspace_id').notNull(),
    kind: dataLifecycleKindEnum('kind').notNull(),
    /** Nulo para `workspace_deletion` (escopo é o workspace inteiro). */
    targetCustomerId: text('target_customer_id'),
    status: backfillStatusEnum('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedByEmail: text('requested_by_email'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Cursor de progresso retry-safe (mesmo padrão do backfill checkpoint). */
    cursor: text('cursor'),
    processedCount: integer('processed_count').notNull().default(0),
    lastError: text('last_error'),
    resultRef: jsonb('result_ref').$type<DataLifecycleResultRef>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceStatusIdx: index('data_lifecycle_requests_ws_status_idx').on(t.workspaceId, t.kind, t.status),
    targetIdx: index('data_lifecycle_requests_ws_target_idx').on(t.workspaceId, t.targetCustomerId),
    subjectKindCheck: check(
      'data_lifecycle_requests_subject_target_check',
      sql`(${t.kind} = 'workspace_deletion' AND ${t.targetCustomerId} IS NULL) OR (${t.kind} <> 'workspace_deletion' AND ${t.targetCustomerId} IS NOT NULL)`,
    ),
  }),
);

export type DataLifecycleRequest = typeof dataLifecycleRequests.$inferSelect;
export type NewDataLifecycleRequest = typeof dataLifecycleRequests.$inferInsert;

/**
 * Order 055 §1 — per-store execution result. One row per (request, store): the
 * request-level `status` (above) summarizes these, but NEVER reports 'completed'
 * while any REQUIRED store here is still 'failed'/'pending'/'running' — enforced in
 * `DataLifecycleService`, not by a DB constraint (the set of required stores is
 * request-kind-dependent). Retrying a request re-runs only the stores NOT already
 * 'completed' (`retrySubjectDeletion`) — the unique index makes that resumption a
 * plain upsert, not a duplicate-row problem.
 */
export const dataLifecycleStoreResults = pgTable(
  'data_lifecycle_store_results',
  {
    workspaceId: text('workspace_id').notNull(),
    id: text('id').notNull(),
    requestId: text('request_id').notNull(),
    /** Store identifier from the code-level erasure registry (e.g. 'customer_context', 'clickhouse_events'). */
    store: text('store').notNull(),
    status: backfillStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Opaque resume point for a store whose erasure spans multiple batches/pages. */
    checkpoint: text('checkpoint'),
    processedCount: integer('processed_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.id] }),
    // `dataLifecycleRequests` has no (workspace_id, id) composite unique constraint
    // (its PK is `id` alone, already globally unique — ULID-based) — FK on `id`
    // only; `workspace_id` here stays a plain filterable column, same "text, not
    // FK" convention already used everywhere else in this schema.
    requestFk: foreignKey({
      name: 'data_lifecycle_store_results_request_fk',
      columns: [t.requestId],
      foreignColumns: [dataLifecycleRequests.id],
    }).onDelete('cascade'),
    naturalUq: uniqueIndex('data_lifecycle_store_results_ws_request_store_uq').on(t.workspaceId, t.requestId, t.store),
    statusIdx: index('data_lifecycle_store_results_ws_status_idx').on(t.workspaceId, t.status),
    storeCheck: check('data_lifecycle_store_results_store_check', sql`length(trim(${t.store})) > 0`),
  }),
);

export type DataLifecycleStoreResult = typeof dataLifecycleStoreResults.$inferSelect;

/**
 * Order 055 §5 — RETENTION ENFORCEMENT. One row per workspace, explicit opt-in:
 * `tombstonePurgeAfterDays IS NULL` (the default — no row, or an explicit null)
 * means the retention sweep SKIPS the workspace entirely. No implicit/global
 * default period is invented — "require/configure explicit policy and fail safely
 * when absent" per the order.
 */
export const dataRetentionSettings = pgTable('data_retention_settings', {
  workspaceId: text('workspace_id').primaryKey(),
  tombstonePurgeAfterDays: integer('tombstone_purge_after_days'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DataRetentionSettings = typeof dataRetentionSettings.$inferSelect;
