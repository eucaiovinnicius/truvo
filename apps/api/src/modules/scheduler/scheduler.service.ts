import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { workspaces } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { withLeaderLock } from '../../common/leader-lock';
import { BillingService } from '../billing/billing.service';
import { CreativeAlertsService } from '../creatives/creative-alerts.service';
import { ReconciliationService } from '../data-quality/reconciliation.service';
import { EventContextQualityService } from '../data-quality/event-context-quality.service';
import { AdsService } from '../creatives/ads/ads.service';
import { RetentionEnforcementService } from '../data-lifecycle/retention-enforcement.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { ConnectorSyncOrchestratorService } from '../connectors/connector-sync-orchestrator.service';
import type { ConnectorLifecycleState } from '@truvo/db';
import { PropensityDispatchService } from '../radars/propensity-dispatch.service';
import { ModelRegistryService } from '../radars/model-registry.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { DecisionsService } from '../decisions/decisions.service';

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
  /** Jobs em execução NESTA réplica — evita reentrância mesmo se o lock expirar antes de o job terminar. */
  private readonly running = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly billing: BillingService,
    private readonly creativeAlerts: CreativeAlertsService,
    private readonly reconciliation: ReconciliationService,
    private readonly quality: EventContextQualityService,
    private readonly ads: AdsService,
    private readonly retention: RetentionEnforcementService,
    private readonly connectorConnections: ConnectorConnectionService,
    private readonly connectorOrchestrator: ConnectorSyncOrchestratorService,
    private readonly connectorRegistry: ConnectorRegistryService,
    @Optional() private readonly propensity?: PropensityDispatchService,
    @Optional() private readonly modelRegistry?: ModelRegistryService,
    @Optional() private readonly opportunities?: OpportunitiesService,
    @Optional() private readonly decisions?: DecisionsService,
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
      { name: 'event-context-quality', intervalMs: HOUR, lockKey: 'truvo:cron:event-context-quality', run: () => this.sweepPerWorkspace(async (ws) => { await this.quality.evaluate(ws); }) },
      { name: 'ads-sync', intervalMs: 24 * HOUR, lockKey: 'truvo:cron:ads-sync', run: () => this.sweepPerWorkspace(async (ws) => { await this.ads.syncWorkspace(ws); }) },
      // Order 055 §5 — retention enforcement: skips a workspace entirely when it
      // has no configured tombstone_purge_after_days (fail-safe, no default).
      { name: 'retention-purge', intervalMs: 24 * HOUR, lockKey: 'truvo:cron:retention-purge', run: () => this.sweepPerWorkspace(async (ws) => { await this.retention.sweepWorkspace(ws); }) },
      // Order 060 §7 — closes Order 050's deferred scheduler decision: incremental
      // sync for every ACTIVE source connection, workspace/connection scoped,
      // checkpointed by the orchestrator itself. Deliberately does NOT touch
      // 'disconnected'/'error'/'draft'/'authorizing' connections (an error state
      // needs a deliberate re-test, not blind repeated polling).
      { name: 'connector-incremental-sync', intervalMs: 15 * 60_000, lockKey: 'truvo:cron:connector-incremental-sync', run: () => this.sweepPerWorkspace((ws) => this.syncConnectorsForWorkspace(ws)) },
      { name: 'propensity-recovery-scoring', intervalMs: HOUR, lockKey: 'truvo:cron:propensity-recovery-scoring', run: () => this.sweepPerWorkspace(async (ws) => { await this.propensity?.sweepWorkspace(ws); await this.modelRegistry?.maintainWorkspace(ws); }) },
      { name: 'opportunity-refresh', intervalMs: 24 * HOUR, lockKey: 'truvo:cron:opportunity-refresh', run: () => this.sweepPerWorkspace(async (ws) => { await this.opportunities?.sweepWorkspace(ws); }) },
      { name: 'decision-reward-reconciliation', intervalMs: HOUR, lockKey: 'truvo:cron:decision-reward-reconciliation', run: () => this.sweepPerWorkspace(async (ws) => { await this.decisions?.reconcileRewards(ws); }) },
    ];
    for (const job of jobs) this.schedule(job);
    this.logger.log(`scheduler ligado: ${jobs.map((j) => j.name).join(', ')}`);
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** Executes the Order 070 quality tick through the same leader-lock contract
   * used by the hourly scheduler. Kept public for a deterministic integration
   * proof without waiting an hour for setInterval. */
  async runQualityEvaluationTick(): Promise<boolean> {
    return withLeaderLock('truvo:cron:event-context-quality', 10 * 60_000, () =>
      this.sweepPerWorkspace((workspaceId) => this.quality.evaluate(workspaceId).then(() => undefined)),
    );
  }

  /** Public deterministic proof for competing scheduler replicas. */
  async runPropensityTick(): Promise<boolean> {
    return withLeaderLock('truvo:cron:propensity-recovery-scoring', 10 * 60_000, () =>
      this.sweepPerWorkspace(async (workspaceId) => { await this.propensity?.sweepWorkspace(workspaceId); await this.modelRegistry?.maintainWorkspace(workspaceId); }),
    );
  }

  /** Order 100 deterministic competing-replica proof through the existing lock. */
  async runOpportunityTick(): Promise<boolean> {
    return withLeaderLock('truvo:cron:opportunity-refresh', 10 * 60_000, () =>
      this.sweepPerWorkspace(async (workspaceId) => { await this.opportunities?.sweepWorkspace(workspaceId); }),
    );
  }
  async runDecisionRewardTick(): Promise<boolean> { return withLeaderLock('truvo:cron:decision-reward-reconciliation', 10 * 60_000, () => this.sweepPerWorkspace(async (workspaceId) => { await this.decisions?.reconcileRewards(workspaceId); })); }

  private schedule(job: Job): void {
    // TTL do lock = min(intervalo, 10min): cobre o job sem segurar além do necessário.
    const ttl = Math.min(job.intervalMs, 10 * 60_000);
    const tick = () => {
      // Reentrância NESTA réplica: se o job anterior ainda roda (ex.: varredura mais
      // longa que o intervalo), pula o tick — não sobrepõe execuções.
      if (this.running.has(job.name)) {
        this.logger.warn(`cron '${job.name}' ainda em execução — tick pulado`);
        return;
      }
      this.running.add(job.name);
      void withLeaderLock(job.lockKey, ttl, job.run)
        .then((ran) => {
          if (ran) this.logger.log(`cron '${job.name}' executado (leader desta réplica)`);
        })
        .catch((e) => this.logger.warn(`cron '${job.name}' falhou: ${(e as Error).message}`))
        .finally(() => this.running.delete(job.name));
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

  /** Lifecycle states worth polling — a connection actively syncing or already
   * healthy/degraded. Explicitly excludes 'draft'/'authorizing' (credentials not
   * yet proven), 'error' (needs a deliberate re-test before resuming), and
   * 'disconnected' (user turned it off) — polling those would silently retry a
   * state a human/operator needs to resolve first. */
  private static readonly POLLABLE_STATES: ConnectorLifecycleState[] = ['connected', 'syncing', 'healthy', 'degraded'];

  private async syncConnectorsForWorkspace(workspaceId: string): Promise<void> {
    const connections = await this.connectorConnections.list(workspaceId);
    for (const connection of connections) {
      if (connection.role === 'destination') continue;
      if (!SchedulerService.POLLABLE_STATES.includes(connection.lifecycleState)) continue;
      // Order 061 — a provider (HubSpot) may declare multiple independent
      // incremental streams (contacts/companies/deals), each with its OWN
      // checkpoint; Shopify (Order 060) declares none, so it keeps polling the
      // single 'default' stream exactly as before.
      const streams = this.connectorRegistry.getDefinition(connection.provider)?.incrementalStreams ?? ['default'];
      for (const stream of streams) {
        try {
          await this.connectorOrchestrator.runIncremental(workspaceId, connection.id, stream);
        } catch (e) {
          this.logger.warn(`connector-incremental-sync falhou p/ ${workspaceId}/${connection.id}/${stream}: ${(e as Error).message}`);
        }
      }
    }
  }
}
