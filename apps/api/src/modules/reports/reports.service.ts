import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `reports`/`reportRuns` só existem em @truvo/db após o barrel
// `schema/index.ts` re-exportar `./reports` (ver StructuredOutput.schemaExports).
import {
  reports,
  reportRuns,
  type Report,
  type ReportRun,
  type ReportBranding,
  type ReportDelivery,
  type ReportFormat,
  type ReportFrequency,
  type ReportRunTrigger,
  type ReportSchedule,
  type ReportSnapshot,
  type ReportTemplate,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { DashboardsService } from '../metrics/dashboards.service';
// REUSO DO M12 (@Global): alertas de relatório roteiam pelo NotificationService. Injeção
// @Optional p/ resiliência caso o NotificationsModule ainda não esteja no AppModule.
import { NotificationService } from '../notifications/notifications.service';
import { ReportRenderService, type ReportRenderContext } from './report-render.service';
import { ReportDeliveryService } from './report-delivery.service';
import { computeNextRun, freezeWindow } from './report-schedule.util';
import {
  REPORT_TOKEN_PREFIX,
  REPORT_RUN_TOKEN_PREFIX,
  reportsPublicBaseUrl,
} from './reports.constants';
import type { CreateReportDto, SendReportDto, UpdateReportDto } from './dto/report.dto';

/** View de gestão (dono) de um relatório. */
export interface ReportView {
  id: string;
  name: string;
  dashboard_id: string;
  template: ReportTemplate;
  period: string;
  frequency: ReportFrequency;
  schedule: ReportSchedule;
  recipients: string[];
  branding: ReportBranding;
  enabled: boolean;
  is_public: boolean;
  public_url: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Resumo de uma execução (histórico). */
export interface ReportRunView {
  id: string;
  report_id: string;
  status: ReportRun['status'];
  trigger: ReportRunTrigger;
  format: ReportFormat;
  period: string | null;
  period_start: string | null;
  period_end: string | null;
  deliveries: ReportDelivery[];
  public_url: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Payload público (read-only) — NUNCA expõe workspace_id. */
export interface PublicReportView {
  report_name: string;
  branding: ReportBranding;
  period: string | null;
  window: ReportSnapshot['window'] | null;
  generated_at: string;
  widgets: Array<Record<string, unknown>>;
}

interface RunOptions {
  trigger: ReportRunTrigger;
  format: ReportFormat;
  period?: string;
  recipients?: string[];
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly dashboards: DashboardsService,
    private readonly render: ReportRenderService,
    private readonly delivery: ReportDeliveryService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  // ─────────────────────────────── CRUD ───────────────────────────────

  async create(workspaceId: string, userId: string | undefined, dto: CreateReportDto): Promise<ReportView> {
    // Valida que o dashboard-fonte pertence ao workspace (404 cedo se não).
    await this.dashboards.get(workspaceId, dto.dashboard_id);

    const now = new Date();
    const frequency = dto.frequency;
    const schedule = (dto.schedule ?? {}) as ReportSchedule;
    const enabled = dto.enabled && frequency !== 'manual';

    const [row] = await this.db
      .insert(reports)
      .values({
        id: ulid(),
        workspaceId,
        name: dto.name,
        dashboardId: dto.dashboard_id,
        template: dto.template,
        period: dto.period,
        frequency,
        schedule,
        recipients: dto.recipients,
        branding: (dto.branding ?? {}) as ReportBranding,
        enabled,
        publicToken: dto.is_public ? `${REPORT_TOKEN_PREFIX}_${ulid()}` : null,
        nextRunAt: enabled ? computeNextRun(frequency, schedule, now) : null,
        lastRunAt: null,
        createdBy: userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('falha ao criar relatório');
    return toReportView(row);
  }

  async list(workspaceId: string): Promise<ReportView[]> {
    const rows = await this.db
      .select()
      .from(reports)
      .where(eq(reports.workspaceId, workspaceId))
      .orderBy(desc(reports.createdAt));
    return rows.map(toReportView);
  }

  async get(workspaceId: string, id: string): Promise<ReportView> {
    return toReportView(await this.getOwned(workspaceId, id));
  }

  async update(workspaceId: string, id: string, dto: UpdateReportDto): Promise<ReportView> {
    const current = await this.getOwned(workspaceId, id);

    if (dto.dashboard_id !== undefined && dto.dashboard_id !== current.dashboardId) {
      await this.dashboards.get(workspaceId, dto.dashboard_id);
    }

    const patch: Partial<Report> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.dashboard_id !== undefined) patch.dashboardId = dto.dashboard_id;
    if (dto.template !== undefined) patch.template = dto.template;
    if (dto.period !== undefined) patch.period = dto.period;
    if (dto.recipients !== undefined) patch.recipients = dto.recipients;
    if (dto.branding !== undefined) patch.branding = dto.branding as ReportBranding;

    // Compartilhamento read-only: liga (gera token se ainda não tem) / desliga (limpa).
    if (dto.is_public !== undefined) {
      patch.publicToken = dto.is_public
        ? current.publicToken ?? `${REPORT_TOKEN_PREFIX}_${ulid()}`
        : null;
    }

    // Agendamento: recomputa nextRunAt quando frequency/schedule/enabled mudam.
    const nextFrequency = (dto.frequency ?? current.frequency) as ReportFrequency;
    const nextSchedule = (dto.schedule ?? current.schedule) as ReportSchedule;
    const nextEnabledRaw = dto.enabled ?? current.enabled;
    const nextEnabled = nextEnabledRaw && nextFrequency !== 'manual';
    if (
      dto.frequency !== undefined ||
      dto.schedule !== undefined ||
      dto.enabled !== undefined
    ) {
      patch.frequency = nextFrequency;
      patch.schedule = nextSchedule;
      patch.enabled = nextEnabled;
      patch.nextRunAt = nextEnabled ? computeNextRun(nextFrequency, nextSchedule, new Date()) : null;
    }

    const [row] = await this.db
      .update(reports)
      .set(patch)
      .where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new NotFoundException('relatório não encontrado');
    return toReportView(row);
  }

  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    // Apaga o histórico junto (runs pertencem ao mesmo tenant).
    await this.db
      .delete(reportRuns)
      .where(and(eq(reportRuns.reportId, id), eq(reportRuns.workspaceId, workspaceId)));
    const [row] = await this.db
      .delete(reports)
      .where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId)))
      .returning({ id: reports.id });
    if (!row) throw new NotFoundException('relatório não encontrado');
    return { id: row.id, deleted: true };
  }

  // ───────────────────────── envio / execução ─────────────────────────

  /** POST /:id/send — dispara uma execução manual/teste. */
  async send(workspaceId: string, id: string, dto: SendReportDto): Promise<ReportRunView> {
    const report = await this.getOwned(workspaceId, id);
    return this.runReport(workspaceId, report, {
      trigger: 'manual',
      format: dto.format,
      period: dto.period,
      recipients: dto.recipients,
    });
  }

  /** GET /:id/history — execuções mais recentes primeiro. */
  async history(workspaceId: string, id: string, limit: number): Promise<ReportRunView[]> {
    await this.getOwned(workspaceId, id); // garante ownership antes de listar runs.
    const rows = await this.db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.reportId, id), eq(reportRuns.workspaceId, workspaceId)))
      .orderBy(desc(reportRuns.createdAt))
      .limit(limit);
    return rows.map((r) => toRunView(r, this.publicUrlFor(r.publicToken, r.branding)));
  }

  /**
   * Núcleo de execução. Congela o snapshot do dashboard-fonte no período e, se for
   * envio por email, entrega aos destinatários. NÃO relança em falha de dados/entrega:
   * registra uma run 'failed' e a devolve (o cliente inspeciona o erro no histórico).
   * Usado tanto por /send quanto pelo scheduler.
   */
  async runReport(workspaceId: string, report: Report, opts: RunOptions): Promise<ReportRunView> {
    const runId = ulid();
    const startedAt = new Date();
    const period = opts.period ?? report.period;
    const { start, end } = freezeWindow(period, startedAt);
    const branding = (report.branding ?? {}) as ReportBranding;
    const runToken = `${REPORT_RUN_TOKEN_PREFIX}_${ulid()}`;

    await this.db.insert(reportRuns).values({
      id: runId,
      workspaceId,
      reportId: report.id,
      status: 'running',
      trigger: opts.trigger,
      format: opts.format,
      period,
      periodStart: start,
      periodEnd: end,
      reportName: report.name,
      branding,
      deliveries: [],
      publicToken: runToken,
      createdAt: startedAt,
    });

    try {
      // Resolve os widgets do dashboard no período (M6/ClickHouse: workspace_id + is_bot=0).
      const data = await this.dashboards.resolveData(workspaceId, report.dashboardId, { period });
      const snapshot: ReportSnapshot = {
        dashboard_id: data.id,
        name: data.name,
        window: data.window,
        widgets: data.widgets,
      };

      let deliveries: ReportDelivery[] = [];
      const recipients = opts.recipients ?? report.recipients ?? [];
      if (opts.format === 'email' && recipients.length > 0) {
        const html = this.render.renderHtml(
          this.renderContext(report.name, branding, snapshot, period, start, end),
        );
        deliveries = await this.delivery.sendReport({
          workspaceId,
          recipients,
          subject: report.name,
          html,
          publicUrl: this.publicUrlFor(runToken, branding) ?? undefined,
        });
      }

      const completedAt = new Date();
      const [row] = await this.db
        .update(reportRuns)
        .set({ status: 'success', snapshot, deliveries, completedAt })
        .where(eq(reportRuns.id, runId))
        .returning();

      // Atualiza cursor de agendamento no relatório (última + próxima execução).
      await this.db
        .update(reports)
        .set({
          lastRunAt: completedAt,
          nextRunAt: report.enabled ? computeNextRun(report.frequency, report.schedule, completedAt) : report.nextRunAt,
          updatedAt: completedAt,
        })
        .where(and(eq(reports.id, report.id), eq(reports.workspaceId, workspaceId)));

      if (!row) throw new Error('run desapareceu após atualização');
      return toRunView(row, this.publicUrlFor(row.publicToken, row.branding));
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const completedAt = new Date();
      const [row] = await this.db
        .update(reportRuns)
        .set({ status: 'failed', error: message.slice(0, 1000), completedAt })
        .where(eq(reportRuns.id, runId))
        .returning();
      await this.notifyFailure(report, message);
      if (!row) throw new NotFoundException('run não encontrada');
      return toRunView(row, this.publicUrlFor(row.publicToken, row.branding));
    }
  }

  // ─────────────────────────── público (read-only) ───────────────────────────

  /**
   * GET /public/:token. Resolve o workspace SERVER-SIDE pelo registro (nunca do request) e
   * renderiza no formato pedido. Aceita token de RELATÓRIO (→ snapshot da última execução
   * bem-sucedida) OU de EXECUÇÃO (→ snapshot congelado daquela run). Sem match → 404.
   *
   * `json` → payload estruturado (sem workspace_id); `html` → white-label renderizado;
   * `pdf` → HTML pronto-para-impressão (conversão binária é TODO(live), ver ReportRenderService).
   */
  async renderPublic(
    token: string,
    format: 'json' | 'html' | 'pdf',
  ): Promise<PublicReportView | string> {
    const run = await this.resolvePublicRun(token);
    const branding = (run.branding ?? {}) as ReportBranding;
    if (format === 'json') return this.publicView(run, branding);

    const ctx = this.publicRenderContext(run, branding);
    return format === 'pdf' ? this.render.renderPdf(ctx).html : this.render.renderHtml(ctx);
  }

  /** Resolve a run publicável (token de relatório → última de sucesso; ou token de run). */
  private async resolvePublicRun(token: string): Promise<ReportRun> {
    const clean = token.trim();
    if (!clean) throw new NotFoundException('relatório não encontrado');

    // 1) token estável do relatório → última run de sucesso.
    const [rep] = await this.db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.publicToken, clean))
      .limit(1);
    if (rep) {
      const [latest] = await this.db
        .select()
        .from(reportRuns)
        .where(and(eq(reportRuns.reportId, rep.id), eq(reportRuns.status, 'success')))
        .orderBy(desc(reportRuns.createdAt))
        .limit(1);
      if (!latest || !latest.snapshot) {
        throw new NotFoundException('relatório ainda não tem execução publicada');
      }
      return latest;
    }

    // 2) token da execução → aquele snapshot específico.
    const [run] = await this.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.publicToken, clean))
      .limit(1);
    if (!run || run.status !== 'success' || !run.snapshot) {
      throw new NotFoundException('relatório não encontrado');
    }
    return run;
  }

  private publicView(run: ReportRun, branding: ReportBranding): PublicReportView {
    const snapshot = run.snapshot as ReportSnapshot;
    return {
      report_name: run.reportName ?? 'Relatório',
      branding,
      period: run.period,
      window: snapshot?.window ?? null,
      generated_at: (run.completedAt ?? run.createdAt).toISOString(),
      widgets: Array.isArray(snapshot?.widgets) ? snapshot.widgets : [],
    };
  }

  private publicRenderContext(run: ReportRun, branding: ReportBranding): ReportRenderContext {
    return {
      reportName: run.reportName ?? 'Relatório',
      branding,
      snapshot: run.snapshot as ReportSnapshot,
      periodLabel: run.period,
      periodStart: run.periodStart ? run.periodStart.toISOString() : null,
      periodEnd: run.periodEnd ? run.periodEnd.toISOString() : null,
      generatedAt: (run.completedAt ?? run.createdAt).toISOString(),
    };
  }

  // ─────────────────────────── helpers ───────────────────────────

  private renderContext(
    reportName: string,
    branding: ReportBranding,
    snapshot: ReportSnapshot,
    period: string,
    start: Date,
    end: Date,
  ): ReportRenderContext {
    return {
      reportName,
      branding,
      snapshot,
      periodLabel: period,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Monta a URL pública (usa o domínio white-label da agência, se houver). */
  private publicUrlFor(token: string | null, branding: ReportBranding | null | undefined): string | null {
    if (!token) return null;
    const domain = branding?.domain?.trim();
    const base = domain ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : reportsPublicBaseUrl();
    return `${base}/v1/reports/public/${token}`;
  }

  /**
   * Alerta de falha de relatório. Roteia pelo M12 (Notificações & Alertas) — regra do
   * projeto: alertas de M5/M10/M13/M14 passam pelo NotificationService. O tipo
   * `report.run_failed` não está no registry do M12 → cai no genérico (in-app), o que é
   * suficiente aqui. Fail-safe: se o M12 não estiver presente/faltar, só loga.
   */
  private async notifyFailure(report: Report, message: string): Promise<void> {
    this.logger.warn(
      `FALHA relatório ${report.id} (ws=${report.workspaceId}, dashboard=${report.dashboardId}): ${message}`,
    );
    if (!this.notifications) return;
    try {
      await this.notifications.dispatch(report.workspaceId, 'report.run_failed', {
        title: `Falha ao gerar o relatório "${report.name}"`,
        body: message.slice(0, 500),
        severity: 'warning',
        dedupId: report.id,
        data: { report_id: report.id, dashboard_id: report.dashboardId },
      });
    } catch (err) {
      // Nunca deixa a notificação derrubar a execução (que já foi registrada como failed).
      this.logger.warn(`falha ao notificar M12 sobre relatório ${report.id}: ${String(err)}`);
    }
  }

  private async getOwned(workspaceId: string, id: string): Promise<Report> {
    const [row] = await this.db
      .select()
      .from(reports)
      .where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('relatório não encontrado');
    return row;
  }
}

// ─────────────────────────── mappers ───────────────────────────

function toReportView(r: Report): ReportView {
  return {
    id: r.id,
    name: r.name,
    dashboard_id: r.dashboardId,
    template: r.template,
    period: r.period,
    frequency: r.frequency,
    schedule: r.schedule ?? {},
    recipients: r.recipients ?? [],
    branding: r.branding ?? {},
    enabled: r.enabled,
    is_public: r.publicToken !== null,
    public_url: r.publicToken ? publicUrl(r.publicToken, r.branding) : null,
    next_run_at: r.nextRunAt ? r.nextRunAt.toISOString() : null,
    last_run_at: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function toRunView(r: ReportRun, publicUrlStr: string | null): ReportRunView {
  return {
    id: r.id,
    report_id: r.reportId,
    status: r.status,
    trigger: r.trigger,
    format: r.format,
    period: r.period,
    period_start: r.periodStart ? r.periodStart.toISOString() : null,
    period_end: r.periodEnd ? r.periodEnd.toISOString() : null,
    deliveries: r.deliveries ?? [],
    public_url: publicUrlStr,
    error: r.error,
    created_at: r.createdAt.toISOString(),
    completed_at: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

/** Versão livre de instância (para os mappers). Espelha ReportsService.publicUrlFor. */
function publicUrl(token: string, branding: ReportBranding | null | undefined): string {
  const domain = branding?.domain?.trim();
  const base = domain
    ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : reportsPublicBaseUrl();
  return `${base}/v1/reports/public/${token}`;
}
