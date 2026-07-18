import {
  boolean,
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * M14 — QUALIDADE DE DADOS & RECONCILIAÇÃO (schema Postgres).
 *
 * O grosso do M14 é analítico e vive no ClickHouse (`reconciliation_daily`,
 * `bot_stats_daily` — ver clickhouse/ddl/06-reconciliation.sql). No Postgres
 * ficam apenas dois artefatos operacionais/transacionais:
 *
 *   - data_quality_settings → configuração por workspace (limiar de gap,
 *     bot-filter on/off, alertas on/off). Sobrescreve o default global do env
 *     (RECONCILIATION_GAP_THRESHOLD).
 *   - reconciliation_alerts → registro (auditável, dedup por workspace+dia) de
 *     cada dia cujo `reconciliation_gap` estourou o limiar. É o ponto de
 *     integração com o M12 (Notificações & Alertas — onda futura): o M12 varre
 *     alertas `open` e dispara e-mail/Slack/in-app (regra 12 + PRD §7 M12).
 *
 * Regras respeitadas:
 *   1  — toda leitura/escrita filtra por workspace_id (índices abaixo).
 *   12 — o gap acima do limiar vira alerta + marca de incerteza no dashboard.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './data-quality'`) na onda de
 * integração para que `@truvo/db` exponha `dataQualitySettings` e
 * `reconciliationAlerts`. O barrel NÃO é editado por este módulo (contrato de
 * arquivos) — reportado em `schemaExports`.
 *
 * Obs.: `workspace_id` é `text` (não FK) para permanecer compatível com o formato
 * de id do M1 (Auth) e com `workspace_id: z.string()` do @truvo/event-schema.
 */

/** Estado de um alerta de reconciliação (consumido pelo M12). */
export const RECONCILIATION_ALERT_STATUSES = ['open', 'notified', 'resolved'] as const;
export type ReconciliationAlertStatus = (typeof RECONCILIATION_ALERT_STATUSES)[number];

export const dataQualitySettings = pgTable('data_quality_settings', {
  /** 1 linha por workspace. */
  workspaceId: text('workspace_id').primaryKey(),
  /**
   * Limiar de `reconciliation_gap` acima do qual o período é marcado como
   * incerto (regra 12). Default de produto: 0.02 (2%, PRD §10). Sobrescreve o
   * default global do env por workspace.
   */
  reconciliationGapThreshold: doublePrecision('reconciliation_gap_threshold')
    .notNull()
    .default(0.02),
  /** Liga/desliga a detecção de bots na ingestão para o workspace (default on). */
  botFilterEnabled: boolean('bot_filter_enabled').notNull().default(true),
  /** Liga/desliga a geração de alertas de reconciliação (default on). */
  alertsEnabled: boolean('alerts_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reconciliationAlerts = pgTable(
  'reconciliation_alerts',
  {
    id: text('id').primaryKey(), // dqa_<ulid>
    workspaceId: text('workspace_id').notNull(),
    /** Dia (UTC) cujo gap estourou o limiar. */
    day: date('day').notNull(),
    /** `reconciliation_gap` observado (|truvo-gateway|/gateway). */
    gap: doublePrecision('gap').notNull(),
    /** Limiar vigente no momento da detecção. */
    threshold: doublePrecision('threshold').notNull(),
    truvoRevenue: doublePrecision('truvo_revenue').notNull().default(0),
    gatewayRevenue: doublePrecision('gateway_revenue').notNull().default(0),
    /** 'open' | 'notified' | 'resolved'. O M12 avança para 'notified'. */
    status: text('status').notNull().default('open'),
    /** Preenchido pelo M12 quando o alerta é efetivamente notificado. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // regra 1: acesso sempre escopado por workspace.
    workspaceIdx: index('reconciliation_alerts_workspace_idx').on(t.workspaceId),
    // dedup: no máximo 1 alerta por (workspace, dia) — recompute faz upsert.
    workspaceDayUq: uniqueIndex('reconciliation_alerts_workspace_day_uq').on(
      t.workspaceId,
      t.day,
    ),
    // varredura do M12: alertas abertos primeiro.
    statusIdx: index('reconciliation_alerts_status_idx').on(t.status),
  }),
);

export type DataQualitySettings = typeof dataQualitySettings.$inferSelect;
export type NewDataQualitySettings = typeof dataQualitySettings.$inferInsert;
export type ReconciliationAlert = typeof reconciliationAlerts.$inferSelect;
export type NewReconciliationAlert = typeof reconciliationAlerts.$inferInsert;
