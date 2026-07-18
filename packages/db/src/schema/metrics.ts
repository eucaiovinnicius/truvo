import { pgTable, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * M6 — METRICS / KPI LAYER + DASHBOARD BUILDER (schema Postgres, PRD §7 Módulo 6).
 *
 * Duas tabelas de definição (a leitura analítica em si é toda no ClickHouse, sobre
 * `events`, sempre com workspace_id + is_bot = 0 — regras 1 e 11):
 *   · kpi_definitions — KPIs customizados (fórmula visual: numerator/denominator/multiplier).
 *   · dashboards      — layout de widgets em grid-12 + token de compartilhamento read-only.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo é re-exportado por `packages/db/src/schema/index.ts`
 * (`export * from './metrics'`) na integração da onda M6 — ver StructuredOutput.schemaExports.
 * Só então `kpiDefinitions`/`dashboards` ficam disponíveis em `@truvo/db` (e o service os importa).
 *
 * Obs.: `workspace_id`/`created_by` são `text` (não FK) — mesmo padrão do M2/M3 — para
 * permanecerem compatíveis com o formato de id do M1 (Auth). Toda leitura/escrita filtra
 * por `workspace_id` (regra 1).
 */

// ─────────────────────────── tipos JSONB (fonte de verdade) ───────────────────────────

/** Agregação de um termo da fórmula de KPI customizado. */
export type KpiAggregation = 'count' | 'sum' | 'unique';

/**
 * Um termo (numerador ou denominador) de um KPI customizado.
 * - `event`: filtra `event_name` (use '*' para todos os eventos).
 * - `aggregation`: count (linhas) | sum (soma de `field`) | unique (distintos de `field`).
 * - `field`: coluna achatada de `events` (value/order_id/user_id/session_id/anonymous_id);
 *            obrigatório p/ sum|unique, ignorado p/ count.
 */
export interface KpiTerm {
  event: string;
  aggregation: KpiAggregation;
  field?: string;
}

/** Fórmula de um KPI customizado: (numerator / denominator) × multiplier. */
export interface KpiFormula {
  numerator: KpiTerm;
  denominator?: KpiTerm;
  multiplier?: number;
}

/** Filtros default aplicados ao avaliar o KPI (período + segmento). */
export interface KpiFilters {
  /** Janela relativa (ex.: 'last_7_days' | 'last_30_days' | 'last_90_days'). */
  period?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  device_type?: string;
  ip_country?: string;
  ip_city?: string;
  os?: string;
  browser?: string;
  source?: string;
}

/** Um widget do Dashboard Builder (grid de 12 colunas). */
export interface DashboardWidget {
  /** Id estável do widget dentro do dashboard (para /data e drill-down). */
  id: string;
  /** Tipo de visualização (o front escolhe o render; o back resolve os dados). */
  type:
    | 'kpi_card'
    | 'line_chart'
    | 'bar_chart'
    | 'pie_chart'
    | 'donut_chart'
    | 'funnel_chart'
    | 'table'
    | 'heatmap'
    | 'cohort';
  title?: string;
  /** Posição/tamanho no grid-12 (x/w em colunas 0..12; y/h em linhas). */
  layout: { x: number; y: number; w: number; h: number };
  /** Descreve o que buscar; resolvido pelo DashboardsService em GET /:id/data. */
  query: DashboardWidgetQuery;
}

/**
 * Query de um widget. Discriminada por `kind` — o resolver mapeia cada uma para o
 * MetricsService (ClickHouse). `kpi_ref` referencia um kpi_definitions.id (KPI custom).
 */
export type DashboardWidgetQuery =
  | { kind: 'kpis'; filters?: KpiFilters }
  | { kind: 'timeseries'; metric: string; granularity?: 'day' | 'week' | 'month'; filters?: KpiFilters }
  | { kind: 'breakdown'; metric: string; dimension: string; limit?: number; filters?: KpiFilters }
  | { kind: 'custom_kpi'; kpi_ref: string; filters?: KpiFilters };

/** Layout completo persistido em dashboards.layout. */
export interface DashboardLayout {
  widgets: DashboardWidget[];
  /** Filtros globais default (date range + segmento) — mesclados em cada widget. */
  globalFilters?: KpiFilters & { start?: string; end?: string };
}

// ─────────────────────────────────── tabelas ───────────────────────────────────

export const kpiDefinitions = pgTable(
  'kpi_definitions',
  {
    /** ULID gerado na aplicação (ver KpisService). */
    id: text('id').primaryKey(),
    /** Tenant dono do KPI (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Fórmula visual (numerator/denominator/multiplier) — sem SQL do cliente. */
    formula: jsonb('formula').$type<KpiFormula>().notNull(),
    /** Filtros default (período + segmento). */
    filters: jsonb('filters').$type<KpiFilters>().notNull().default({}),
    /** Dimensões de segmentação sugeridas (utm_source, device_type, ...). */
    segmentBy: jsonb('segment_by').$type<string[]>().notNull().default([]),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('kpi_definitions_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

export const dashboards = pgTable(
  'dashboards',
  {
    /** ULID gerado na aplicação (ver DashboardsService). */
    id: text('id').primaryKey(),
    /** Tenant dono do dashboard (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Widgets em grid-12 + filtros globais. */
    layout: jsonb('layout').$type<DashboardLayout>().notNull().default({ widgets: [] }),
    /**
     * Token de compartilhamento read-only. NULL = privado. Quando presente,
     * GET /v1/dashboards/public/:token resolve o workspace SERVER-SIDE por este
     * registro — nunca a partir do request (segurança multi-tenant).
     */
    publicToken: text('public_token'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('dashboards_workspace_idx').on(t.workspaceId, t.createdAt),
    // Unique sobre o token; múltiplos NULL não colidem no Postgres (dashboards privados).
    publicTokenUq: uniqueIndex('dashboards_public_token_uq').on(t.publicToken),
  }),
);

export type KpiDefinition = typeof kpiDefinitions.$inferSelect;
export type NewKpiDefinition = typeof kpiDefinitions.$inferInsert;
export type Dashboard = typeof dashboards.$inferSelect;
export type NewDashboard = typeof dashboards.$inferInsert;
