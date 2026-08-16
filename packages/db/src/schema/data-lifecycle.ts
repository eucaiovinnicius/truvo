import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
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
