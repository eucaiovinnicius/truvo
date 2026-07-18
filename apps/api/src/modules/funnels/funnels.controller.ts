import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import { FunnelsService } from './funnels.service';
import type { DropoffUser } from './funnel-calc.service';
import {
  createFunnelSchema,
  dropoffQuerySchema,
  statsQuerySchema,
  updateFunnelSchema,
  type CreateFunnelDto,
  type DropoffQueryDto,
  type StatsQueryDto,
  type UpdateFunnelDto,
} from './dto/funnel.dto';

/**
 * M5 — Funnel Engine. CRUD + analytics de funis (PRD §7 M5).
 *
 * Auth (reuso do M1): SupabaseAuthGuard (autentica) + WorkspaceGuard (resolve o
 * tenant + @Roles). O parâmetro de rota é `:funnelId` (NÃO `:id`) de propósito —
 * o WorkspaceGuard resolve o workspace por `params.id` OU pelo header
 * `x-workspace-id`; usando `:funnelId` o workspace vem SEMPRE do header
 * `x-workspace-id` (regra 1), sem colidir com o id do funil.
 *
 * Papéis: criar/editar/excluir exigem owner|admin|member (viewer só lê) —
 * matriz de permissões do M1 (`createFunnelsDashboards`).
 */
@Controller('v1/funnels')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class FunnelsController {
  constructor(private readonly funnels: FunnelsService) {}

  @Get()
  list(@CurrentWorkspace('id') workspaceId: string) {
    return this.funnels.list(workspaceId);
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  create(
    @CurrentWorkspace('id') workspaceId: string,
    @Body(new ZodValidationPipe(createFunnelSchema)) dto: CreateFunnelDto,
  ) {
    return this.funnels.create(workspaceId, dto);
  }

  @Get(':funnelId')
  get(@CurrentWorkspace('id') workspaceId: string, @Param('funnelId') funnelId: string) {
    return this.funnels.get(workspaceId, funnelId);
  }

  @Patch(':funnelId')
  @Roles('owner', 'admin', 'member')
  update(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('funnelId') funnelId: string,
    @Body(new ZodValidationPipe(updateFunnelSchema)) dto: UpdateFunnelDto,
  ) {
    return this.funnels.update(workspaceId, funnelId, dto);
  }

  @Delete(':funnelId')
  @HttpCode(200)
  @Roles('owner', 'admin', 'member')
  remove(@CurrentWorkspace('id') workspaceId: string, @Param('funnelId') funnelId: string) {
    return this.funnels.remove(workspaceId, funnelId);
  }

  @Get(':funnelId/stats')
  stats(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('funnelId') funnelId: string,
    @Query(new ZodValidationPipe(statsQuerySchema)) query: StatsQueryDto,
  ) {
    return this.funnels.stats(workspaceId, funnelId, query);
  }

  @Get(':funnelId/preview')
  preview(@CurrentWorkspace('id') workspaceId: string, @Param('funnelId') funnelId: string) {
    return this.funnels.preview(workspaceId, funnelId);
  }

  /**
   * GET /v1/funnels/:id/dropoff/:stepId — usuários que abandonaram no step.
   * `?format=csv` responde text/csv (export do PRD); default é JSON.
   */
  @Get(':funnelId/dropoff/:stepId')
  async dropoff(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('funnelId') funnelId: string,
    @Param('stepId') stepId: string,
    @Query(new ZodValidationPipe(dropoffQuerySchema)) query: DropoffQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.funnels.dropoff(workspaceId, funnelId, stepId, query);
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dropoff_${funnelId}_${stepId}.csv"`);
      return toCsv(result.users);
    }
    return result;
  }
}

/** Serializa a lista de usuários de drop-off em CSV (RFC 4180 básico). */
function toCsv(users: DropoffUser[]): string {
  const header = ['user_key', 'user_id', 'anonymous_id', 'utm_source', 'device_type', 'ip_country', 'last_event_at'];
  const escape = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = users.map((u) =>
    [u.user_key, u.user_id, u.anonymous_id, u.utm_source, u.device_type, u.ip_country, u.last_event_at]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}
