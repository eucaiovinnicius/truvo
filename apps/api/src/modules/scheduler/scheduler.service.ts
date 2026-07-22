import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { workspaces } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { withLeaderLock } from '../../common/leader-lock';
import { BillingService } from '../billing/billing.service';
import { CreativeAlertsService } from '../creatives/creative-alerts.service';
import { ReconciliationService } from '../data-quality/reconciliation.service';
import { AdsService } from '../creatives/ads/ads.service';

interface Job {
  name: string;
  intervalMs: number;
  lockKey: string;
  run: () => Promise<void>;
}

/**
 * M-crons — SCHEDULER de jobs periódicos que antes NÃO tinham gatilho (só endpoint
 * manual): varredura de billing/excedente (M11), alertas de criativo (M10),
 * reconciliação (M14) e sync diário de Ads (M10). Segue o padrão in-process do repo
 * (setInterval em OnModuleInit, como o retry do M4 e o scheduler de relatórios do
 * M13), mas cada tick roda atrás de um LEADER-LOCK Redis — em N réplicas, só uma
 * dispara o job (sem duplicar). Fail-safe: sem Redis, o tick é pulado.
 *
 * OFF por padrão (SCHEDULER_ENABLED != 1) — igual ao scheduler de relatórios; a
 * infra de prod liga com SCHEDULER_ENABLED=1. Cada job itera os workspaces ativos e
 * é best-effort por workspace (um erro não derruba os demais nem o tick).
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly billing: BillingService,
    private readonly creativeAlerts: CreativeAlertsService,
    private readonly reconciliation: ReconciliationService,
    private readonly ads: AdsService,
  ) {}

  onModuleInit(): void {
    if (process.env.SCHEDULER_ENABLED !== '1') {
      this.logger.log('scheduler de jobs desligado (SCHEDULER_ENABLED != 1)');
      return;
    }
    const HOUR = 60 * 60_000;
    const jobs: Job[] = [
      { name: 'billing-usage', intervalMs: 15 * 60_000, lockKey: 'truvo:cron:billing-usage', run: () => this.sweepPerWorkspace((ws) => this.billing.sweepUsage(ws)) },
      { name: 'creative-alerts', intervalMs: HOUR, lockKey: 'truvo:cron:creative-alerts', run: () => this.sweepPerWorkspace(async (ws) => { await this.creativeAlerts.getAlerts(ws, { persist: true }); }) },
      { name: 'reconciliation', intervalMs: HOUR, lockKey: 'truvo:cron:reconciliation', run: () => this.sweepPerWorkspace(async (ws) => { await this.reconciliation.getReconciliation(ws, undefined, undefined); }) },
      { name: 'ads-sync', intervalMs: 24 * HOUR, lockKey: 'truvo:cron:ads-sync', run: () => this.sweepPerWorkspace(async (ws) => { await this.ads.syncWorkspace(ws); }) },
    ];
    for (const job of jobs) this.schedule(job);
    this.logger.log(`scheduler ligado: ${jobs.map((j) => j.name).join(', ')}`);
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private schedule(job: Job): void {
    // TTL do lock = min(intervalo, 10min): cobre o job sem segurar além do necessário.
    const ttl = Math.min(job.intervalMs, 10 * 60_000);
    const tick = () => {
      void withLeaderLock(job.lockKey, ttl, job.run)
        .then((ran) => {
          if (ran) this.logger.log(`cron '${job.name}' executado (leader desta réplica)`);
        })
        .catch((e) => this.logger.warn(`cron '${job.name}' falhou: ${(e as Error).message}`));
    };
    const timer = setInterval(tick, job.intervalMs);
    if (typeof timer.unref === 'function') timer.unref(); // não segura o processo
    this.timers.push(timer);
  }

  /** IDs de todos os workspaces (base da varredura). */
  private async activeWorkspaceIds(): Promise<string[]> {
    const rows = await this.db.select({ id: workspaces.id }).from(workspaces);
    return rows.map((r) => String(r.id));
  }

  /** Roda `fn(ws)` para cada workspace, best-effort (erro de um não derruba os outros). */
  private async sweepPerWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
    const ids = await this.activeWorkspaceIds();
    for (const ws of ids) {
      try {
        await fn(ws);
      } catch (e) {
        this.logger.warn(`sweep falhou p/ workspace ${ws}: ${(e as Error).message}`);
      }
    }
  }
}
