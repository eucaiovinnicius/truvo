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
import { DashboardsService } from './dashboards.service';
import {
  createDashboardSchema,
  updateDashboardSchema,
  dashboardDataQuerySchema,
  type CreateDashboardDto,
  type UpdateDashboardDto,
  type DashboardDataQueryDto,
} from './dto/dashboard.dto';

/**
 * M6 — Dashboard Builder (PRD §7 M6). CRUD + GET /:id/data (resolve widgets).
 * O endpoint público (GET /public/:token) fica em PublicDashboardsController
 * (sem auth). Leituras: qualquer membro. Mutações: owner/admin/member.
 */
@Controller('v1/dashboards')
@UseGuards(SupabaseAuthGuard, WorkspaceScopeGuard)
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.dashboards.list(ws.id);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.dashboards.get(ws.id, id);
  }

  /** GET /v1/dashboards/:id/data — resolve os dados de todos os widgets. */
  @Get(':id/data')
  data(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(dashboardDataQuerySchema)) q: DashboardDataQueryDto,
  ) {
    return this.dashboards.resolveData(ws.id, id, q);
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'member')
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(createDashboardSchema)) dto: CreateDashboardDto,
  ) {
    return this.dashboards.create(ws.id, userId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'member')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDashboardSchema)) dto: UpdateDashboardDto,
  ) {
    return this.dashboards.update(ws.id, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin', 'member')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.dashboards.remove(ws.id, id);
  }
}
