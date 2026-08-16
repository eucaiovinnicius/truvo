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
import { CurrentUserId, CurrentWorkspace } from './decorators/current-workspace.decorator';
import {
  createIntegrationSchema,
  listIntegrationsQuerySchema,
  logsQuerySchema,
  updateIntegrationSchema,
  type CreateIntegrationDto,
  type ListIntegrationsQuery,
  type LogsQuery,
  type UpdateIntegrationDto,
} from './dto/integration.dto';
import { WorkspaceAuthGuard } from './guards/workspace-auth.guard';
import { IntegrationsService } from './integrations.service';

/**
 * CRUD de integrações (PRD §7 M4). Protegido por JWT do Supabase + workspace
 * (WorkspaceAuthGuard). Toda operação é escopada por workspace (regra 1).
 */
@Controller('v1/integrations')
@UseGuards(WorkspaceAuthGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query(new ZodValidationPipe(listIntegrationsQuerySchema)) query: ListIntegrationsQuery,
  ) {
    return this.integrations.list(workspaceId, query);
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @Body(new ZodValidationPipe(createIntegrationSchema)) dto: CreateIntegrationDto,
    @CurrentUserId() userId: string | undefined,
  ) {
    return this.integrations.create(workspaceId, dto, userId);
  }

  @Get(':id')
  get(@CurrentWorkspace() workspaceId: string, @Param('id') id: string) {
    return this.integrations.get(workspaceId, id);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateIntegrationSchema)) dto: UpdateIntegrationDto,
    @CurrentUserId() userId: string | undefined,
  ) {
    return this.integrations.update(workspaceId, id, dto, userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param('id') id: string,
    @CurrentUserId() userId: string | undefined,
  ): Promise<void> {
    await this.integrations.remove(workspaceId, id, userId);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@CurrentWorkspace() workspaceId: string, @Param('id') id: string) {
    return this.integrations.test(workspaceId, id);
  }

  @Get(':id/logs')
  logs(
    @CurrentWorkspace() workspaceId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(logsQuerySchema)) query: LogsQuery,
  ) {
    return this.integrations.logs(workspaceId, id, query);
  }
}
