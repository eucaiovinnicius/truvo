import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import { ReconciliationService } from './reconciliation.service';
import { BotDetectionService } from './bot-detection.service';
import { DiscrepancyService } from './discrepancy.service';
import { EventContextQualityService } from './event-context-quality.service';
import {
  botReportQuerySchema,
  discrepancyQuerySchema,
  reconciliationQuerySchema,
  reconciliationRunSchema,
  type BotReportQueryDto,
  type DiscrepancyQueryDto,
  type ReconciliationQueryDto,
  type ReconciliationRunDto,
  qualityEvaluationSchema, type QualityEvaluationDto,
} from './dto/data-quality.dto';

/**
 * M14 — QUALIDADE DE DADOS & RECONCILIAÇÃO (endpoints, PRD §M14).
 *
 * Auth: SupabaseAuthGuard (JWT do M1) + WorkspaceGuard (membership + papel). O
 * `workspace_id` vem do contexto resolvido (`@CurrentWorkspace('id')`, via header
 * `x-workspace-id`) — o cliente NUNCA o escolhe no corpo/query (regra 1).
 *
 *   GET  /v1/data-quality/reconciliation?start=&end=
 *   GET  /v1/data-quality/bot-report?start=&end=
 *   GET  /v1/data-quality/discrepancy?ad_account=&start=&end=
 *   POST /v1/data-quality/reconciliation/run   (admin/owner — força recompute)
 */
@Controller('v1/data-quality')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class DataQualityController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly botDetection: BotDetectionService,
    private readonly discrepancy: DiscrepancyService,
    private readonly quality: EventContextQualityService,
  ) {}

  @Get('reconciliation')
  getReconciliation(
    @Query(new ZodValidationPipe(reconciliationQuerySchema)) q: ReconciliationQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.reconciliation.getReconciliation(workspaceId, q.start, q.end);
  }

  @Get('bot-report')
  getBotReport(
    @Query(new ZodValidationPipe(botReportQuerySchema)) q: BotReportQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.botDetection.report(workspaceId, q.start, q.end);
  }

  @Get('discrepancy')
  getDiscrepancy(
    @Query(new ZodValidationPipe(discrepancyQuerySchema)) q: DiscrepancyQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.discrepancy.getDiscrepancy(workspaceId, q.ad_account, q.start, q.end);
  }

  /**
   * Força o recompute+persistência de um intervalo (útil p/ backfill/manual e
   * enquanto não há o job diário agendado — ver openTODOs). Restrito a owner/admin.
   */
  @Post('reconciliation/run')
  @Roles('owner', 'admin')
  runReconciliation(
    @Body(new ZodValidationPipe(reconciliationRunSchema)) body: ReconciliationRunDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.reconciliation.reconcileRange(workspaceId, body.start, body.end, {
      persist: true,
    });
  }

  @Get('quality') getQuality(@CurrentWorkspace('id') workspaceId: string) { return this.quality.getSummary(workspaceId); }
  @Get('quality/issues') listQualityIssues(@Query('status') status: string | undefined, @CurrentWorkspace('id') workspaceId: string) { return this.quality.listIssues(workspaceId, status); }
  @Get('quality/issues/:issueId') getQualityIssue(@Param('issueId') issueId: string, @CurrentWorkspace('id') workspaceId: string) { return this.quality.getIssue(workspaceId, issueId); }
  @Post('quality/evaluate') @Roles('owner', 'admin') evaluateQuality(@Body(new ZodValidationPipe(qualityEvaluationSchema)) body: QualityEvaluationDto, @CurrentWorkspace('id') workspaceId: string) { return this.quality.evaluate(workspaceId, body); }
  @Post('quality/radar-readiness') radarReadiness(@Body(new ZodValidationPipe(qualityEvaluationSchema)) body: QualityEvaluationDto, @CurrentWorkspace('id') workspaceId: string) { return this.quality.evaluate(workspaceId, body).then((result) => result.radarReadiness); }
}
