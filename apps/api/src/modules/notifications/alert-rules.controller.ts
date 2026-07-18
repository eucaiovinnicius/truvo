import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { AlertRulesService } from './alert-rules.service';
import {
  createAlertRuleSchema,
  updateAlertRuleSchema,
  type CreateAlertRuleDto,
  type UpdateAlertRuleDto,
} from './dto/notifications.dto';

/**
 * M12 — CRUD de regras de alerta (PRD §7 M12).
 *
 *   GET    /v1/alerts/rules
 *   POST   /v1/alerts/rules            (owner/admin)
 *   PATCH  /v1/alerts/rules/:id        (owner/admin)
 *   DELETE /v1/alerts/rules/:id        (owner/admin)
 *
 * Configurar alertas é gestão do workspace → restrito a owner/admin (mesma classe
 * de "gerenciar integrações" na matriz de permissões do M1). Leitura liberada a
 * todos os membros.
 */
@Controller('v1/alerts/rules')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class AlertRulesController {
  constructor(private readonly rules: AlertRulesService) {}

  @Get()
  list(@CurrentWorkspace('id') workspaceId: string) {
    return this.rules.list(workspaceId);
  }

  @Post()
  @Roles('owner', 'admin')
  create(
    @Body(new ZodValidationPipe(createAlertRuleSchema)) dto: CreateAlertRuleDto,
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.rules.create(workspaceId, userId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'admin')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAlertRuleSchema)) dto: UpdateAlertRuleDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.rules.update(workspaceId, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@Param('id') id: string, @CurrentWorkspace('id') workspaceId: string) {
    return this.rules.remove(workspaceId, id);
  }
}
