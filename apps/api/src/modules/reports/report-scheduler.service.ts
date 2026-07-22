import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { reports, type Report } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { withLeaderLock } from '../../common/leader-lock';
import { ReportsService } from './reports.service';
import { schedulerEnabled, schedulerScanMs } from './reports.constants';

const BATCH_SIZE = 25;

/**
 * M13 — Scheduler de relatórios agendados (diário/semanal/mensal).
 *
 * Varre `reports` habilitados com `next_run_at` vencido e dispara `runReport` (que congela
 * o snapshot e entrega por email). Após rodar, `runReport` já recomputa `next_run_at`.
 *
 * ESTRUTURA (segue o padrão do worker de retry do M4): setInterval in-process, ligado só
 * quando `REPORTS_SCHEDULER_ENABLED=1` (default OFF). Cada varredura roda atrás de um
 * LEADER-LOCK Redis (withLeaderLock) — com N réplicas da API, só uma varre por tick,
 * evitando envio duplicado de relatórios. // TODO(live): claim por relatório (SELECT ...
 * FOR UPDATE SKIP LOCKED) permitiria paralelizar entre réplicas; o lock aqui já garante
 * a corretude (uma varredura por vez).
 */
@Injectable()
export class ReportSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly reportsService: ReportsService,
  ) {}

  onModuleInit(): void {
    if (!schedulerEnabled()) {
      this.logger.log('scheduler de relatórios desligado (REPORTS_SCHEDULER_ENABLED != 1)');
      return;
    }
    const ms = schedulerScanMs();
    this.timer = setInterval(() => void this.scheduledTick(), ms);
    this.timer.unref?.();
    this.logger.log(`scheduler de relatórios ativo (scan a cada ${ms}ms)`);
  }

  /** Varredura agendada protegida por leader-lock: em N réplicas, só uma varre por tick. */
  private async scheduledTick(): Promise<void> {
    await withLeaderLock('truvo:cron:reports-scheduler', 5 * 60_000, async () => {
      await this.tick();
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Uma varredura de relatórios agendados vencidos. Reentrância protegida por `running`. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      const due = await this.db
        .select()
        .from(reports)
        .where(and(eq(reports.enabled, true), isNotNull(reports.nextRunAt), lte(reports.nextRunAt, now)))
        .limit(BATCH_SIZE);

      for (const report of due) {
        await this.runOne(report);
        processed++;
      }
    } catch (err) {
      this.logger.error(`falha na varredura do scheduler: ${String(err)}`);
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async runOne(report: Report): Promise<void> {
    try {
      // Determina o formato pela existência de destinatários: com lista → email; senão só web.
      const format = (report.recipients?.length ?? 0) > 0 ? 'email' : 'web';
      await this.reportsService.runReport(report.workspaceId, report, {
        trigger: 'scheduled',
        format,
      });
    } catch (err) {
      // runReport já registra run 'failed' + notifyFailure; aqui só evitamos derrubar o loop.
      this.logger.error(`relatório ${report.id} falhou no scheduler: ${String(err)}`);
    }
  }
}
