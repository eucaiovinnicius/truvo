import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DashboardsService } from './dashboards.service';
import { dashboardDataQuerySchema, type DashboardDataQueryDto } from './dto/dashboard.dto';

/**
 * M6 — compartilhamento read-only de dashboards. SEM auth (público) e SEM guard de
 * workspace: o tenant é resolvido SERVER-SIDE pelo registro do dashboard (via
 * public_token), NUNCA a partir do request. Só dashboards com token ativo resolvem.
 *
 * Rota `public/:token` (2 segmentos) não colide com `:id` (1 seg) nem `:id/data`
 * (2 seg, estático 'data') do DashboardsController.
 */
@Controller('v1/dashboards')
export class PublicDashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  /** GET /v1/dashboards/public/:token — dados read-only do dashboard compartilhado. */
  @Get('public/:token')
  publicData(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(dashboardDataQuerySchema)) q: DashboardDataQueryDto,
  ) {
    return this.dashboards.resolvePublic(token, q);
  }
}
