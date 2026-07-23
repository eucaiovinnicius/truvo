import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { FeatureGuard } from '../billing/feature.guard';
import { RequireFeature } from '../billing/feature.decorator';
import type { AiInsight, AiJourneyRun, AiObjective, AiRecommendation } from '@truvo/db';
import { AiRunsService } from './runs.service';
import { AiConversationsService } from './conversations.service';
import type { AiGoal } from './ai.constants';
import {
  analyzeSchema,
  askSchema,
  bestQuerySchema,
  createObjectiveSchema,
  recommendationsQuerySchema,
  type AnalyzeDto,
  type AskDto,
  type BestQueryDto,
  type CreateObjectiveDto,
  type RecommendationsQueryDto,
} from './dto/ai.dto';

/**
 * M17 — AI JOURNEY INTELLIGENCE (PRD §7 M17). Rotas /v1/ai/*.
 *
 * Auth (reuso do M1): SupabaseAuthGuard + WorkspaceGuard. Nenhuma rota usa o param
 * `:id` (o WorkspaceGuard resolveria como workspace) — os params são `:runId` e
 * `:insightId`, então o workspace vem SEMPRE do header `x-workspace-id` (regra 1),
 * mesmo padrão do M7. Rotas de mutação exigem papel >= member (viewer é read-only).
 *
 * Gate de PLANO: todo o M17 é a feature `ai_journey` (Agency/Enterprise, M11) — o
 * @RequireFeature no nível da classe + FeatureGuard negam com 402 fora do plano
 * (role-gated: exige owner/admin). Independente da ANTHROPIC_API_KEY (que só liga a
 * geração; sem ela as rotas de LLM já respondem 503).
 */
@Controller('v1/ai')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard, FeatureGuard)
@RequireFeature('ai_journey')
export class AiController {
  constructor(
    private readonly runs: AiRunsService,
    private readonly conversations: AiConversationsService,
  ) {}

  // ─────────────────────────── objetivos ───────────────────────────

  /** POST /v1/ai/objectives — cria um objetivo salvo. */
  @Post('objectives')
  @Roles('owner', 'admin', 'member')
  async createObjective(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string | undefined,
    @Body(new ZodValidationPipe(createObjectiveSchema)) dto: CreateObjectiveDto,
  ) {
    const obj = await this.runs.createObjective(workspaceId, userId, {
      name: dto.name,
      goal: dto.goal,
      windowDays: dto.window_days,
      segment: dto.segment,
    });
    return mapObjective(obj);
  }

  /** GET /v1/ai/objectives — lista os objetivos do workspace. */
  @Get('objectives')
  async listObjectives(@CurrentWorkspace('id') workspaceId: string) {
    const rows = await this.runs.listObjectives(workspaceId);
    return { objectives: rows.map(mapObjective) };
  }

  // ─────────────────────────── análise assíncrona ───────────────────────────

  /** POST /v1/ai/journeys/analyze — inicia um run ASSÍNCRONO. Retorna run_id p/ polling. */
  @Post('journeys/analyze')
  @Roles('owner', 'admin', 'member')
  async analyze(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string | undefined,
    @Body(new ZodValidationPipe(analyzeSchema)) dto: AnalyzeDto,
  ) {
    const run = await this.runs.startRun(workspaceId, userId, {
      objectiveId: dto.objective_id,
      goal: dto.goal,
      windowDays: dto.window_days,
      start: dto.start,
      end: dto.end,
      segment: dto.segment,
    });
    return {
      run_id: run.id,
      status: run.status,
      llm_available: run.llmAvailable,
      poll: `/v1/ai/journeys/runs/${run.id}`,
    };
  }

  /** GET /v1/ai/journeys/runs/:runId — status + resultado do run (polling). */
  @Get('journeys/runs/:runId')
  async getRun(@CurrentWorkspace('id') workspaceId: string, @Param('runId') runId: string) {
    const { run, insights, recommendations } = await this.runs.getRun(workspaceId, runId);
    return {
      run: mapRun(run, true),
      insights: insights.map(mapInsight),
      recommendations: recommendations.map(mapRecommendation),
    };
  }

  // ─────────────────────────── best journeys (determinístico, síncrono) ───────────────────────────

  /** GET /v1/ai/journeys/best?goal=&window_days=&start=&end=&segment_channel=&limit= */
  @Get('journeys/best')
  async best(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(bestQuerySchema)) q: BestQueryDto,
  ) {
    return this.runs.bestJourneys(
      workspaceId,
      q.goal as AiGoal,
      q.start,
      q.end,
      q.window_days,
      q.segment_channel ? { channel: q.segment_channel } : undefined,
      q.limit ?? 10,
    );
  }

  // ─────────────────────────── recomendações / evidência ───────────────────────────

  /** GET /v1/ai/recommendations?run_id= — do run informado ou do último run bem-sucedido. */
  @Get('recommendations')
  async recommendations(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(recommendationsQuerySchema)) q: RecommendationsQueryDto,
  ) {
    const rows = await this.runs.listRecommendations(workspaceId, q.run_id);
    return { recommendations: rows.map(mapRecommendation) };
  }

  /** GET /v1/ai/insights/:insightId/evidence — evidence pack que ancora o insight. */
  @Get('insights/:insightId/evidence')
  async insightEvidence(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('insightId') insightId: string,
  ) {
    const { insight, evidence_ref, evidence } = await this.runs.getInsightEvidence(workspaceId, insightId);
    return { insight: mapInsight(insight), evidence_ref, evidence };
  }

  // ─────────────────────────── Q&A (text-to-query M16) ───────────────────────────

  /** POST /v1/ai/ask — pergunta em NL respondida via ExplorerQuerySpec (M16). */
  @Post('ask')
  @Roles('owner', 'admin', 'member')
  async ask(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string | undefined,
    @Body(new ZodValidationPipe(askSchema)) dto: AskDto,
  ) {
    return this.conversations.ask(workspaceId, userId, dto.question, dto.conversation_id);
  }
}

// ─────────────────────────── mapeamento p/ resposta ───────────────────────────

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

function mapObjective(o: AiObjective) {
  return {
    id: o.id,
    name: o.name,
    goal: o.goal,
    window_days: o.windowDays,
    segment: o.segment ?? null,
    created_by: o.createdBy ?? null,
    created_at: toIso(o.createdAt),
    updated_at: toIso(o.updatedAt),
  };
}

function mapRun(r: AiJourneyRun, includeEvidence = false) {
  const base = {
    id: r.id,
    objective_id: r.objectiveId ?? null,
    goal: r.goal,
    status: r.status,
    window_days: r.windowDays,
    window: { start: toIso(r.windowStart), end: toIso(r.windowEnd) },
    segment: r.segment ?? null,
    llm_available: r.llmAvailable,
    llm_model: r.llmModel ?? null,
    reconciliation_gap: r.reconciliationGap ?? null,
    uncertain: r.uncertain,
    narrative: r.narrative ?? null,
    error: r.error ?? null,
    created_at: toIso(r.createdAt),
    started_at: toIso(r.startedAt),
    completed_at: toIso(r.completedAt),
  };
  return includeEvidence ? { ...base, evidence: r.evidence ?? null } : base;
}

function mapInsight(i: AiInsight) {
  return {
    id: i.id,
    run_id: i.runId,
    severity: i.severity,
    title: i.title,
    body: i.body,
    metric: i.metric ?? null,
    channel: i.channel ?? null,
    evidence_ref: i.evidenceRef ?? null,
    created_at: toIso(i.createdAt),
  };
}

function mapRecommendation(r: AiRecommendation) {
  return {
    id: r.id,
    run_id: r.runId,
    title: r.title,
    rationale: r.rationale,
    action: r.action ?? null,
    expected_impact: r.expectedImpact ?? null,
    priority: r.priority,
    channel: r.channel ?? null,
    evidence_ref: r.evidenceRef ?? null,
    status: r.status,
    created_at: toIso(r.createdAt),
  };
}
