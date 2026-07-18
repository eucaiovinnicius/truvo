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
// REUSO do guard de escopo do M6: resolve o workspace pelo header `x-workspace-id`
// (ou ?workspace_id=), NUNCA pelo param `:id` — aqui `:id` é o id do RELATÓRIO, não o tenant.
import { WorkspaceScopeGuard } from '../metrics/guards/workspace-scope.guard';
import { ReportsService } from './reports.service';
import {
  createReportSchema,
  updateReportSchema,
  sendReportSchema,
  historyQuerySchema,
  type CreateReportDto,
  type UpdateReportDto,
  type SendReportDto,
  type HistoryQueryDto,
} from './dto/report.dto';

/**
 * M13 — Relatórios (PRD §7 M13). CRUD + envio manual + histórico.
 * O endpoint público (GET /public/:token) fica em PublicReportsController (sem auth).
 * Leituras: qualquer membro. Mutações/envio: owner/admin/member.
 */
@Controller('v1/reports')
@UseGuards(SupabaseAuthGuard, WorkspaceScopeGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.reports.list(ws.id);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.reports.get(ws.id, id);
  }

  @Get(':id/history')
  history(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(historyQuerySchema)) q: HistoryQueryDto,
  ) {
    return this.reports.history(ws.id, id, q.limit);
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(createReportSchema)) dto: CreateReportDto,
  ) {
    return this.reports.create(ws.id, userId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'member')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateReportSchema)) dto: UpdateReportDto,
  ) {
    return this.reports.update(ws.id, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin', 'member')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.reports.remove(ws.id, id);
  }

  /** POST /v1/reports/:id/send — dispara uma execução manual/teste (congela snapshot + envia). */
  @Post(':id/send')
  @HttpCode(202)
  @Roles('owner', 'admin', 'member')
  send(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sendReportSchema)) dto: SendReportDto,
  ) {
    return this.reports.send(ws.id, id, dto);
  }
}
