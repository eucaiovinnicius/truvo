import { pgTable, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * M13 — RELATÓRIOS (agendados + white-label) (schema Postgres, PRD §7 Módulo 13).
 *
 * Duas tabelas (a leitura analítica em si vem do M6/ClickHouse via DashboardsService,
 * sempre com workspace_id + is_bot = 0 — regras 1 e 11):
 *   · reports      — config do relatório: dashboard-fonte, agendamento (freq + próxima
 *                    execução), lista de destinatários, branding white-label e token
 *                    público estável (link web read-only).
 *   · report_runs  — histórico de execuções. Cada run CONGELA o snapshot dos dados do
 *                    período (não muda depois de enviado — PRD §7 M13 "Snapshot") junto
 *                    com o branding vigente e o resultado das entregas (email).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo é re-exportado por `packages/db/src/schema/index.ts`
 * (`export * from './reports'`) na integração da onda M13 — ver StructuredOutput.schemaExports.
 * Só então `reports`/`reportRuns` ficam disponíveis em `@truvo/db` (e o service os importa).
 *
 * Obs.: `workspace_id`/`dashboard_id`/`created_by` são `text` (não FK) — mesmo padrão de
 * M6 (dashboards) — para compatibilidade com o formato de id do M1/M6. Toda leitura/escrita
 * filtra por `workspace_id` (regra 1).
 */

// ─────────────────────────── enums (aplicação, não pgEnum) ───────────────────────────

/** Frequência do agendamento. `manual` = só dispara por /send. */
export type ReportFrequency = 'manual' | 'daily' | 'weekly' | 'monthly';

/** Template de partida (define copy/branding default no front; o back só persiste o rótulo). */
export type ReportTemplate = 'client_report' | 'ads_performance' | 'monthly_funnel' | 'custom';

/** Formato de entrega de uma execução. */
export type ReportFormat = 'web' | 'email' | 'pdf';

/** Status de uma execução (report_runs). */
export type ReportRunStatus = 'pending' | 'running' | 'success' | 'failed';

/** Origem do disparo de uma execução. */
export type ReportRunTrigger = 'manual' | 'scheduled';

// ─────────────────────────── tipos JSONB (fonte de verdade) ───────────────────────────

/**
 * Agendamento fino. `frequency` no topo governa a cadência; estes campos refinam
 * QUANDO no dia/semana/mês. `timezone` é IANA (default herda do workspace no service).
 * // TODO(live): resolução de fuso usa cálculo naïve (UTC) — ver report-schedule.util.ts.
 */
export interface ReportSchedule {
  /** Hora do dia (0..23) em que a execução agendada dispara. Default 8. */
  hour?: number;
  /** Dia da semana (0=domingo..6=sábado) — só p/ frequency='weekly'. Default 1 (segunda). */
  weekday?: number;
  /** Dia do mês (1..28) — só p/ frequency='monthly'. Default 1. Limitado a 28 p/ existir em todo mês. */
  dayOfMonth?: number;
  /** IANA tz (ex.: 'America/Sao_Paulo'). Default = timezone do workspace. */
  timezone?: string;
}

/**
 * Branding white-label (PRD §7 M13). Todos opcionais; o render aplica defaults do Truvo
 * quando ausentes. Cores em hex (#rgb|#rrggbb). `domain` é o domínio da agência p/ o link
 * público (usado só para montar a URL exibida — o token continua resolvendo server-side).
 */
export interface ReportBranding {
  logoUrl?: string;
  companyName?: string;
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  domain?: string;
  footerText?: string;
}

/**
 * Snapshot CONGELADO dos dados do dashboard no período. É exatamente o payload retornado
 * por DashboardsService.resolveData (id/name/window/widgets[...]) no instante da execução —
 * nunca re-consultado depois (regra do M13). Tipado como estrutura aberta p/ desacoplar do
 * shape interno de cada widget do M6.
 */
export interface ReportSnapshot {
  dashboard_id: string;
  name: string;
  window: { start: string | null; end: string | null; period: string | null };
  widgets: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** Resultado da entrega a UM destinatário (canal email). */
export interface ReportDelivery {
  channel: 'email';
  recipient: string;
  status: 'sent' | 'skipped' | 'failed';
  error?: string;
  providerId?: string;
  at: string;
}

// ─────────────────────────────────── tabelas ───────────────────────────────────

export const reports = pgTable(
  'reports',
  {
    /** ULID gerado na aplicação (ver ReportsService). */
    id: text('id').primaryKey(),
    /** Tenant dono do relatório (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    /** Dashboard-fonte (M6). O snapshot resolve os widgets deste dashboard. */
    dashboardId: text('dashboard_id').notNull(),
    /** Template de partida (rótulo). */
    template: text('template').$type<ReportTemplate>().notNull().default('custom'),
    /** Janela relativa dos dados (last_7_days | last_30_days | ...). Ver metrics RELATIVE_PERIODS. */
    period: text('period').notNull().default('last_30_days'),
    /** Cadência do agendamento. `manual` = sem agendamento. */
    frequency: text('frequency').$type<ReportFrequency>().notNull().default('manual'),
    /** Refino do agendamento (hora/dia/semana/tz). */
    schedule: jsonb('schedule').$type<ReportSchedule>().notNull().default({}),
    /** Destinatários de email (envio automático). */
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
    /** Branding white-label aplicado ao render. */
    branding: jsonb('branding').$type<ReportBranding>().notNull().default({}),
    /** Liga/desliga o agendamento. Só reports com enabled + nextRunAt vencido rodam no scheduler. */
    enabled: boolean('enabled').notNull().default(false),
    /**
     * Token de compartilhamento read-only ESTÁVEL. NULL = privado. Quando presente,
     * GET /v1/reports/public/:token resolve o workspace SERVER-SIDE por este registro
     * (nunca do request) e devolve o snapshot da execução mais recente (regra multi-tenant).
     */
    publicToken: text('public_token'),
    /** Próxima execução agendada (UTC). NULL quando manual/desligado. Varrido pelo scheduler. */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** Última execução concluída. */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('reports_workspace_idx').on(t.workspaceId, t.createdAt),
    // Varredura do scheduler: relatórios habilitados com próxima execução vencida.
    dueIdx: index('reports_due_idx').on(t.enabled, t.nextRunAt),
    // Unique sobre o token; múltiplos NULL não colidem no Postgres (reports privados).
    publicTokenUq: uniqueIndex('reports_public_token_uq').on(t.publicToken),
  }),
);

export const reportRuns = pgTable(
  'report_runs',
  {
    /** ULID gerado na aplicação. */
    id: text('id').primaryKey(),
    /** Tenant dono (regra 1) — desnormalizado do report p/ filtrar sem join. */
    workspaceId: text('workspace_id').notNull(),
    reportId: text('report_id').notNull(),
    status: text('status').$type<ReportRunStatus>().notNull().default('pending'),
    trigger: text('trigger').$type<ReportRunTrigger>().notNull().default('manual'),
    format: text('format').$type<ReportFormat>().notNull().default('web'),
    /** Janela CONGELADA da execução (para exibir no relatório e auditar). */
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    /** Rótulo do período relativo usado (last_7_days, ...). */
    period: text('period'),
    /** Nome do relatório congelado no instante da execução (renomear o report não altera runs antigas). */
    reportName: text('report_name'),
    /** Snapshot congelado dos dados do dashboard (NUNCA re-consultado). */
    snapshot: jsonb('snapshot').$type<ReportSnapshot>(),
    /** Branding congelado no instante da execução. */
    branding: jsonb('branding').$type<ReportBranding>(),
    /** Resultado por destinatário (email). */
    deliveries: jsonb('deliveries').$type<ReportDelivery[]>().notNull().default([]),
    /**
     * Token público POR EXECUÇÃO (permalink do snapshot congelado). Resolvido pelo mesmo
     * endpoint /public/:token (o resolver tenta report token → última run, depois run token).
     */
    publicToken: text('public_token'),
    /** Mensagem de erro quando status='failed'. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    reportIdx: index('report_runs_report_idx').on(t.reportId, t.createdAt),
    workspaceIdx: index('report_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    publicTokenUq: uniqueIndex('report_runs_public_token_uq').on(t.publicToken),
  }),
);

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type ReportRun = typeof reportRuns.$inferSelect;
export type NewReportRun = typeof reportRuns.$inferInsert;
