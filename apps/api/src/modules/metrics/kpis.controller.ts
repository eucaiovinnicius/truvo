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
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CurrentUser, CurrentWorkspace, Roles, type WorkspaceContext } from '../auth/decorators';
import { WorkspaceScopeGuard } from './guards/workspace-scope.guard';
import { KpisService } from './kpis.service';
import {
  createKpiSchema,
  updateKpiSchema,
  evaluateKpiQuerySchema,
  type CreateKpiDto,
  type UpdateKpiDto,
  type EvaluateKpiQueryDto,
} from './dto/kpi.dto';

/**
 * M6 — CRUD de KPIs customizados (PRD §7 M6). Leituras: qualquer membro. Mutações:
 * owner/admin/member (matriz "criar funis/dashboards" do M1; viewer é bloqueado
 * pelo WorkspaceScopeGuard via @Roles).
 */
@Controller('v1/kpis')
@UseGuards(SupabaseAuthGuard, WorkspaceScopeGuard)
export class KpisController {
  constructor(private readonly kpis: KpisService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.kpis.list(ws.id);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.kpis.get(ws.id, id);
  }

  /** GET /v1/kpis/:id/value — avalia o KPI (janela do request > filtros salvos). */
  @Get(':id/value')
  value(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(evaluateKpiQuerySchema)) q: EvaluateKpiQueryDto,
  ) {
    return this.kpis.evaluate(ws.id, id, q);
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(createKpiSchema)) dto: CreateKpiDto,
  ) {
    return this.kpis.create(ws.id, userId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'member')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateKpiSchema)) dto: UpdateKpiDto,
  ) {
    return this.kpis.update(ws.id, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin', 'member')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.kpis.remove(ws.id, id);
  }
}
