import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: tabelas/tipos `ai*` vêm de @truvo/db SÓ após o barrel
// `schema/index.ts` re-exportar `./ai` (ver schemaExports) — padrão M7/M16.
import {
  aiInsights,
  aiJourneyRuns,
  aiObjectives,
  aiRecommendations,
  type AiChannelEvidence,
  type AiEvidencePack,
  type AiEvidenceRef,
  type AiInsight,
  type AiInsightSeverity,
  type AiJourneyRun,
  type AiObjective,
  type AiRecommendation,
  type AiSegment,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AiEvidenceService } from './evidence.service';
import { AiAnalystService, type AnalystInsight, type AnalystOutput, type AnalystRecommendation } from './analyst.service';
import { NOTIFICATION_PROVIDER, type NotificationProvider } from './notification.provider';
import {
  AI_INSIGHT_SEVERITIES,
  ANALYSIS_MODEL,
  coerceWindowDays,
  resolveWindow,
  type AiGoal,
  type AnalysisWindow,
} from './ai.constants';

export interface StartRunParams {
  objectiveId?: string;
  goal?: AiGoal;
  windowDays?: number;
  start?: string;
  end?: string;
  segment?: AiSegment;
}

export interface UpsertObjectiveParams {
  name: string;
  goal: AiGoal;
  windowDays?: number;
  segment?: AiSegment;
}

/**
 * M17 — orquestração dos runs ASSÍNCRONOS + objetivos + best-journeys + evidência.
 *
 * Fluxo do /journeys/analyze:
 *   1. cria `ai_journey_runs` status 'queued' e retorna { run_id } (polling);
 *   2. processRun (background): 'running' → Fase 1 (evidence pack determinístico) →
 *      roteia anomalias ao M12 → Fase 2 (LLM, se disponível) → persiste insights/
 *      recomendações → 'succeeded'. Falha → 'failed' + error.
 *
 * // TODO(live): o processamento é in-process (fire-and-forget). Em produção, migrar
 * para uma fila durável (Redis/BullMQ) para sobreviver a restart e escalar — sem
 * mudar o contrato de polling. Runs 'running' órfãos após restart devem ser varridos.
 */
@Injectable()
export class AiRunsService {
  private readonly logger = new Logger(AiRunsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly evidence: AiEvidenceService,
    private readonly analyst: AiAnalystService,
    @Inject(NOTIFICATION_PROVIDER) private readonly notifications: NotificationProvider,
  ) {}

  // ─────────────────────────── objetivos ───────────────────────────

  async createObjective(
    workspaceId: string,
    userId: string | undefined,
    params: UpsertObjectiveParams,
  ): Promise<AiObjective> {
    const now = new Date();
    const row = {
      id: `obj_${ulid()}`,
      workspaceId,
      name: params.name,
      goal: params.goal,
      windowDays: coerceWindowDays(params.windowDays),
      segment: params.segment ?? null,
      createdBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(aiObjectives).values(row);
    return row as AiObjective;
  }

  async listObjectives(workspaceId: string): Promise<AiObjective[]> {
    return this.db
      .select()
      .from(aiObjectives)
      .where(eq(aiObjectives.workspaceId, workspaceId))
      .orderBy(desc(aiObjectives.createdAt))
      .limit(200);
  }

  private async getObjective(workspaceId: string, objectiveId: string): Promise<AiObjective | undefined> {
    const rows = await this.db
      .select()
      .from(aiObjectives)
      .where(and(eq(aiObjectives.workspaceId, workspaceId), eq(aiObjectives.id, objectiveId)))
      .limit(1);
    return rows[0];
  }

  // ─────────────────────────── runs (async) ───────────────────────────

  /** Cria o run 'queued', dispara o processamento e retorna a linha (polling). */
  async startRun(
    workspaceId: string,
    userId: string | undefined,
    params: StartRunParams,
  ): Promise<AiJourneyRun> {
    let goal = params.goal;
    let windowDays = params.windowDays;
    let segment = params.segment;
    let objectiveId: string | null = params.objectiveId ?? null;

    if (params.objectiveId) {
      const obj = await this.getObjective(workspaceId, params.objectiveId);
      if (!obj) throw new NotFoundException('Objetivo não encontrado neste workspace');
      goal = goal ?? obj.goal;
      windowDays = windowDays ?? obj.windowDays;
      segment = segment ?? (obj.segment ?? undefined);
      objectiveId = obj.id;
    }
    if (!goal) throw new NotFoundException('goal ausente (informe goal ou um objective_id válido)');

    const win = resolveWindow(params.start, params.end, coerceWindowDays(windowDays));
    const now = new Date();
    const runId = `run_${ulid()}`;
    const row = {
      id: runId,
      workspaceId,
      objectiveId,
      goal,
      windowDays: win.days,
      windowStart: win.start,
      windowEnd: win.end,
      segment: segment ?? null,
      status: 'queued' as const,
      llmModel: null,
      llmAvailable: this.analyst.available(),
      reconciliationGap: null,
      uncertain: false,
      evidence: null,
      narrative: null,
      error: null,
      requestedBy: userId ?? null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };
    await this.db.insert(aiJourneyRuns).values(row);

    // fire-and-forget (in-process). Ver TODO(live) sobre fila durável.
    void this.processRun(runId, workspaceId, goal, win, segment ?? null).catch((err) => {
      this.logger.error(`processRun falhou (run=${runId}): ${errMessage(err)}`);
    });

    return row as unknown as AiJourneyRun;
  }

  /** Processamento em background de um run. */
  private async processRun(
    runId: string,
    workspaceId: string,
    goal: AiGoal,
    win: AnalysisWindow,
    segment: AiSegment | null,
  ): Promise<void> {
    await this.db
      .update(aiJourneyRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(aiJourneyRuns.workspaceId, workspaceId), eq(aiJourneyRuns.id, runId)));

    try {
      // Fase 1 — determinística (sempre roda, independe do LLM).
      const pack = await this.evidence.buildEvidencePack(workspaceId, goal, win, segment);

      // Anomalias → M12 (best-effort, não falha o run).
      await this.routeAnomalies(workspaceId, pack);

      // Fase 2 — LLM (fail-closed: se indisponível, o run ainda entrega o evidence).
      let narrative: string | null = null;
      let llmModel: string | null = null;
      if (this.analyst.available()) {
        try {
          const output = await this.analyst.analyze(pack);
          narrative = output.summary;
          llmModel = ANALYSIS_MODEL;
          await this.persistOutputs(workspaceId, runId, output);
        } catch (err) {
          // LLM falhou/recusou: preserva o determinístico, marca o motivo.
          this.logger.warn(`Fase 2 (LLM) falhou (run=${runId}): ${errMessage(err)}`);
          narrative = null;
        }
      }

      await this.db
        .update(aiJourneyRuns)
        .set({
          status: 'succeeded',
          evidence: pack,
          reconciliationGap: pack.reconciliation.reconciliation_gap,
          uncertain: pack.uncertain,
          narrative,
          llmModel,
          llmAvailable: this.analyst.available(),
          completedAt: new Date(),
        })
        .where(and(eq(aiJourneyRuns.workspaceId, workspaceId), eq(aiJourneyRuns.id, runId)));
    } catch (err) {
      await this.db
        .update(aiJourneyRuns)
        .set({ status: 'failed', error: errMessage(err), completedAt: new Date() })
        .where(and(eq(aiJourneyRuns.workspaceId, workspaceId), eq(aiJourneyRuns.id, runId)));
    }
  }

  /** Persiste insights + recomendações do LLM, ancorando cada um no evidence_ref. */
  private async persistOutputs(workspaceId: string, runId: string, output: AnalystOutput): Promise<void> {
    const now = new Date();
    const insightRows = output.insights.map((i) => this.toInsightRow(workspaceId, runId, i, now));
    const recRows = output.recommendations.map((r, idx) => this.toRecommendationRow(workspaceId, runId, r, idx, now));
    if (insightRows.length > 0) await this.db.insert(aiInsights).values(insightRows);
    if (recRows.length > 0) await this.db.insert(aiRecommendations).values(recRows);
  }

  private toInsightRow(workspaceId: string, runId: string, i: AnalystInsight, now: Date) {
    return {
      id: `aii_${ulid()}`,
      workspaceId,
      runId,
      severity: coerceSeverity(i.severity),
      title: i.title,
      body: i.body,
      metric: i.metric ?? null,
      channel: i.channel ?? null,
      evidenceRef: toEvidenceRef(i.evidence_ref, i.channel, i.metric),
      createdAt: now,
    };
  }

  private toRecommendationRow(
    workspaceId: string,
    runId: string,
    r: AnalystRecommendation,
    idx: number,
    now: Date,
  ) {
    return {
      id: `rec_${ulid()}`,
      workspaceId,
      runId,
      goal: null,
      title: r.title,
      rationale: r.rationale,
      action: r.action ?? null,
      expectedImpact: r.expected_impact ?? null,
      priority: typeof r.priority === 'number' ? r.priority : idx,
      channel: r.channel ?? null,
      evidenceRef: toEvidenceRef(r.evidence_ref, r.channel),
      status: 'proposed' as const,
      createdAt: now,
    };
  }

  /** Encaminha cada anomalia determinística ao M12 (NOTIFICATION_PROVIDER). */
  private async routeAnomalies(workspaceId: string, pack: AiEvidencePack): Promise<void> {
    for (const a of pack.anomalies) {
      try {
        await this.notifications.notify({
          workspaceId,
          kind: 'ai_anomaly',
          severity: a.severity,
          title: `Anomalia (${a.metric}) — ${a.channel}`,
          body: a.note,
          data: { metric: a.metric, channel: a.channel, current: a.current, previous: a.previous, change_pct: a.change_pct },
        });
      } catch (err) {
        this.logger.warn(`falha ao rotear anomalia ao M12 (ws=${workspaceId}): ${errMessage(err)}`);
      }
    }
  }

  // ─────────────────────────── leitura de runs ───────────────────────────

  async getRun(
    workspaceId: string,
    runId: string,
  ): Promise<{ run: AiJourneyRun; insights: AiInsight[]; recommendations: AiRecommendation[] }> {
    const run = await this.loadRun(workspaceId, runId);
    const [insights, recommendations] = await Promise.all([
      this.db
        .select()
        .from(aiInsights)
        .where(and(eq(aiInsights.workspaceId, workspaceId), eq(aiInsights.runId, runId))),
      this.db
        .select()
        .from(aiRecommendations)
        .where(and(eq(aiRecommendations.workspaceId, workspaceId), eq(aiRecommendations.runId, runId)))
        .orderBy(aiRecommendations.priority),
    ]);
    return { run, insights, recommendations };
  }

  private async loadRun(workspaceId: string, runId: string): Promise<AiJourneyRun> {
    const rows = await this.db
      .select()
      .from(aiJourneyRuns)
      .where(and(eq(aiJourneyRuns.workspaceId, workspaceId), eq(aiJourneyRuns.id, runId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException('Run não encontrado neste workspace');
    return run;
  }

  async listRecommendations(workspaceId: string, runId?: string): Promise<AiRecommendation[]> {
    const targetRunId = runId ?? (await this.latestSucceededRunId(workspaceId));
    if (!targetRunId) return [];
    return this.db
      .select()
      .from(aiRecommendations)
      .where(and(eq(aiRecommendations.workspaceId, workspaceId), eq(aiRecommendations.runId, targetRunId)))
      .orderBy(aiRecommendations.priority);
  }

  private async latestSucceededRunId(workspaceId: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ id: aiJourneyRuns.id })
      .from(aiJourneyRuns)
      .where(and(eq(aiJourneyRuns.workspaceId, workspaceId), eq(aiJourneyRuns.status, 'succeeded')))
      .orderBy(desc(aiJourneyRuns.createdAt))
      .limit(1);
    return rows[0]?.id;
  }

  /** Resolve o evidence_ref de um insight → fatia do evidence pack do run. */
  async getInsightEvidence(
    workspaceId: string,
    insightId: string,
  ): Promise<{ insight: AiInsight; evidence_ref: AiEvidenceRef | null; evidence: unknown }> {
    const rows = await this.db
      .select()
      .from(aiInsights)
      .where(and(eq(aiInsights.workspaceId, workspaceId), eq(aiInsights.id, insightId)))
      .limit(1);
    const insight = rows[0];
    if (!insight) throw new NotFoundException('Insight não encontrado neste workspace');

    const run = await this.loadRun(workspaceId, insight.runId);
    const ref = insight.evidenceRef ?? null;
    const slice = resolveEvidenceSlice(run.evidence ?? null, ref);
    return { insight, evidence_ref: ref, evidence: slice };
  }

  // ─────────────────────────── best journeys (determinístico) ───────────────────────────

  /**
   * "Melhores jornadas por canal" — SÍNCRONO e 100% determinístico (sem LLM). Monta
   * o evidence pack (Fase 1) e ranqueia canais pelo objetivo, além de expor as top
   * sequências. Base do dashboard sem esperar o run assíncrono/LLM.
   */
  async bestJourneys(
    workspaceId: string,
    goal: AiGoal,
    startIso: string | undefined,
    endIso: string | undefined,
    windowDays: number | undefined,
    segment: AiSegment | undefined,
    limit: number,
  ) {
    const win = resolveWindow(startIso, endIso, coerceWindowDays(windowDays));
    const pack = await this.evidence.buildEvidencePack(workspaceId, goal, win, segment ?? null);

    const ranked = [...pack.channels]
      .map((c) => ({ channel: c, score: goalScore(goal, c) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (b.score as number) - (a.score as number))
      .slice(0, limit)
      .map((x, i) => ({ rank: i + 1, ...x.channel, goal_score: x.score }));

    return {
      goal,
      window: pack.window,
      spend_available: pack.spend_available,
      attribution_model: pack.attribution_model,
      uncertain: pack.uncertain,
      reconciliation: pack.reconciliation,
      best_channels: ranked,
      top_journeys: pack.top_journeys.slice(0, limit),
      anomalies: pack.anomalies,
    };
  }
}

// ─────────────────────────── helpers de módulo ───────────────────────────

/** Score determinístico por objetivo (maior = melhor; para CAC, inverte). */
function goalScore(goal: AiGoal, c: AiChannelEvidence): number | null {
  switch (goal) {
    case 'maximize_roas':
      return c.roas;
    case 'minimize_cac':
      return c.cac == null ? null : -c.cac;
    case 'maximize_ltv':
      return c.ltv_proxy;
    case 'maximize_cvr':
      return c.cvr_wilson_lower;
    case 'maximize_revenue':
      return c.attributed_revenue;
    default:
      return null;
  }
}

function coerceSeverity(v: string): AiInsightSeverity {
  return (AI_INSIGHT_SEVERITIES as readonly string[]).includes(v) ? (v as AiInsightSeverity) : 'info';
}

function toEvidenceRef(key: string, channel?: string, metric?: string): AiEvidenceRef {
  return { key: key || 'evidence', channel: channel, metric: metric };
}

/**
 * Resolve uma chave textual (ex.: 'channels.paid_social', 'reconciliation',
 * 'top_journeys') numa fatia do evidence pack. Best-effort: se não casar, devolve o
 * canal referenciado (se houver) ou o pack inteiro.
 */
function resolveEvidenceSlice(pack: AiEvidencePack | null, ref: AiEvidenceRef | null): unknown {
  if (!pack) return null;
  if (!ref) return pack;

  // por canal explícito no ref.
  if (ref.channel) {
    const ch = pack.channels.find((c) => c.channel === ref.channel);
    if (ch) return ch;
  }

  const key = ref.key ?? '';
  if (key.startsWith('channels.')) {
    const name = key.slice('channels.'.length);
    const ch = pack.channels.find((c) => c.channel === name);
    if (ch) return ch;
    return pack.channels;
  }
  if (key.startsWith('reconciliation')) return pack.reconciliation;
  if (key.startsWith('top_journeys')) return pack.top_journeys;
  if (key.startsWith('anomalies')) return pack.anomalies;
  if (key.startsWith('totals')) return pack.totals;
  if (key === 'channels') return pack.channels;
  return pack;
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
