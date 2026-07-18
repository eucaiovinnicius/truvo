import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import type { AttributionModel } from '@truvo/db';
import { AttributionService } from './attribution.service';
import { resolveReportWindow } from './attribution.constants';
import {
  campaignBreakdownQuerySchema,
  compareQuerySchema,
  pathsQuerySchema,
  reportQuerySchema,
  updateSettingsSchema,
  type CampaignBreakdownQueryDto,
  type CompareQueryDto,
  type PathsQueryDto,
  type ReportQueryDto,
  type UpdateSettingsDto,
} from './dto/attribution-query.dto';

/**
 * M7 — ATTRIBUTION ENGINE (PRD §7 M7). Leitura de atribuição multi-touch sobre a
 * tabela `touchpoints` (M8) + `events` (M2), SEMPRE com workspace_id + is_bot = 0.
 *
 * Auth (reuso do M1): SupabaseAuthGuard (autentica) + WorkspaceGuard (resolve o
 * tenant). Nenhuma rota tem param `:id` de recurso, então o WorkspaceGuard resolve
 * o workspace SEMPRE pelo header `x-workspace-id` (regra 1) — mesmo padrão do M6.
 */
@Controller('v1/attribution')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  /** GET /v1/attribution/report?model=&start=&end=&window= */
  @Get('report')
  report(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(reportQuerySchema)) q: ReportQueryDto,
  ) {
    return this.attribution.report(
      workspaceId,
      { model: q.model, windowDays: q.window },
      resolveReportWindow(q.start, q.end),
    );
  }

  /** GET /v1/attribution/compare?models=last_click,linear&start=&end=&window= */
  @Get('compare')
  compare(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(compareQuerySchema)) q: CompareQueryDto,
  ) {
    return this.attribution.compare(
      workspaceId,
      q.models as AttributionModel[],
      { windowDays: q.window },
      resolveReportWindow(q.start, q.end),
    );
  }

  /** GET /v1/attribution/paths?start=&end=&limit=&window= */
  @Get('paths')
  paths(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(pathsQuerySchema)) q: PathsQueryDto,
  ) {
    return this.attribution.paths(
      workspaceId,
      q.limit,
      { windowDays: q.window },
      resolveReportWindow(q.start, q.end),
    );
  }

  /** GET /v1/attribution/campaign-breakdown?channel=&model=&start=&end=&window= */
  @Get('campaign-breakdown')
  campaignBreakdown(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(campaignBreakdownQuerySchema)) q: CampaignBreakdownQueryDto,
  ) {
    return this.attribution.campaignBreakdown(
      workspaceId,
      { model: q.model, windowDays: q.window },
      q.channel,
      q.limit,
      resolveReportWindow(q.start, q.end),
    );
  }

  /** GET /v1/attribution/settings — config de atribuição do workspace. */
  @Get('settings')
  async getSettings(@CurrentWorkspace('id') workspaceId: string) {
    const s = await this.attribution.getSettings(workspaceId);
    return {
      default_model: s.defaultModel,
      default_window_days: s.defaultWindowDays,
      time_decay_half_life_days: s.timeDecayHalfLifeDays,
      updated_at: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
    };
  }

  /** PUT /v1/attribution/settings — atualiza a config (viewer é read-only). */
  @Put('settings')
  @Roles('owner', 'admin', 'member')
  async updateSettings(
    @CurrentWorkspace('id') workspaceId: string,
    @Body(new ZodValidationPipe(updateSettingsSchema)) dto: UpdateSettingsDto,
  ) {
    const s = await this.attribution.updateSettings(workspaceId, {
      default_model: dto.default_model as AttributionModel | undefined,
      default_window_days: dto.default_window_days,
      time_decay_half_life_days: dto.time_decay_half_life_days,
    });
    return {
      default_model: s.defaultModel,
      default_window_days: s.defaultWindowDays,
      time_decay_half_life_days: s.timeDecayHalfLifeDays,
      updated_at: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
    };
  }
}
