import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { InsightsService } from './insights.service';
import {
  createInsightSchema,
  createShareSchema,
  toCreateInsightDto,
  toUpdateInsightDto,
  updateInsightSchema,
  type CreateShareDto,
} from './dto/insight.dto';

/**
 * M16 — Insights salvos (biblioteca self-serve): CRUD + run + versionamento +
 * compartilhamento read-only.
 *
 * Auth (reuso do M1): SupabaseAuthGuard + WorkspaceGuard. O parâmetro de rota é
 * `:insightId` (NÃO `:id`) de propósito — o WorkspaceGuard resolve o workspace pelo
 * header `x-workspace-id`, nunca tratando o id do insight como tenant (regra 1).
 *
 * Papéis: criar/editar/excluir/compartilhar exigem owner|admin|member (viewer só
 * lê e roda) — matriz do M1 (`createFunnelsDashboards`).
 */
@Controller('v1/insights')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  list(@CurrentWorkspace('id') workspaceId: string) {
    return this.insights.list(workspaceId);
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  create(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(createInsightSchema)) raw: unknown,
  ) {
    return this.insights.create(
      workspaceId,
      userId,
      toCreateInsightDto(raw as ReturnType<typeof createInsightSchema.parse>),
    );
  }

  @Get(':insightId')
  get(@CurrentWorkspace('id') workspaceId: string, @Param('insightId') insightId: string) {
    return this.insights.get(workspaceId, insightId);
  }

  @Patch(':insightId')
  @Roles('owner', 'admin', 'member')
  update(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('insightId') insightId: string,
    @Body(new ZodValidationPipe(updateInsightSchema)) raw: unknown,
  ) {
    return this.insights.update(
      workspaceId,
      userId,
      insightId,
      toUpdateInsightDto(raw as ReturnType<typeof updateInsightSchema.parse>),
    );
  }

  @Delete(':insightId')
  @HttpCode(200)
  @Roles('owner', 'admin', 'member')
  remove(@CurrentWorkspace('id') workspaceId: string, @Param('insightId') insightId: string) {
    return this.insights.remove(workspaceId, insightId);
  }

  /** POST /v1/insights/:id/run — roda o insight salvo e retorna dados + custo. */
  @Post(':insightId/run')
  @HttpCode(200)
  run(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('insightId') insightId: string,
  ) {
    return this.insights.run(workspaceId, userId, insightId);
  }

  @Get(':insightId/versions')
  versions(@CurrentWorkspace('id') workspaceId: string, @Param('insightId') insightId: string) {
    return this.insights.listVersions(workspaceId, insightId);
  }

  @Post(':insightId/restore/:versionId')
  @HttpCode(200)
  @Roles('owner', 'admin', 'member')
  restore(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('insightId') insightId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.insights.restore(workspaceId, userId, insightId, versionId);
  }

  @Post(':insightId/share')
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  share(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('insightId') insightId: string,
    @Body(new ZodValidationPipe(createShareSchema)) dto: CreateShareDto,
  ) {
    return this.insights.createShare(workspaceId, userId, insightId, dto);
  }

  @Delete(':insightId/share/:shareId')
  @HttpCode(200)
  @Roles('owner', 'admin', 'member')
  deleteShare(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('insightId') insightId: string,
    @Param('shareId') shareId: string,
  ) {
    return this.insights.deleteShare(workspaceId, insightId, shareId);
  }
}
