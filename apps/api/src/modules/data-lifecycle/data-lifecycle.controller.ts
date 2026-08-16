import { Controller, Get, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, Roles } from '../auth/decorators';
import { DataLifecycleService } from './data-lifecycle.service';

/**
 * Order 035 §5 — superfície mínima executável dos fluxos de titular/workspace.
 * Reusa EXATAMENTE os guards existentes (SupabaseAuthGuard + WorkspaceGuard +
 * @Roles) — nenhum modelo de auth paralelo. `owner|admin` para export/deleção de
 * titular (operação administrativa sensível); `owner` (mesmo padrão de
 * `DELETE /v1/workspaces/:id`) para a deleção do workspace inteiro.
 */
@Controller('v1/workspaces/:id/data-lifecycle')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class DataLifecycleController {
  constructor(private readonly lifecycle: DataLifecycleService) {}

  @Post('subjects/:customerId/export')
  @HttpCode(202)
  @Roles('owner', 'admin')
  exportSubject(
    @Param('id') workspaceId: string,
    @Param('customerId') customerId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.lifecycle.requestSubjectExport(workspaceId, customerId, user);
  }

  @Post('subjects/:customerId/delete')
  @HttpCode(202)
  @Roles('owner', 'admin')
  deleteSubject(
    @Param('id') workspaceId: string,
    @Param('customerId') customerId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.lifecycle.requestSubjectDeletion(workspaceId, customerId, user);
  }

  /** Order 055 §1 — resumes an existing subject_deletion request, re-running only
   * the stores that are not yet 'completed'. */
  @Post('requests/:requestId/retry')
  @HttpCode(202)
  @Roles('owner', 'admin')
  retrySubjectDeletion(
    @Param('id') workspaceId: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.lifecycle.retrySubjectDeletion(workspaceId, requestId, user);
  }

  @Post('delete')
  @HttpCode(202)
  @Roles('owner')
  deleteWorkspace(
    @Param('id') workspaceId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.lifecycle.requestWorkspaceDeletion(workspaceId, user);
  }

  @Get('requests/:requestId')
  @Roles('owner', 'admin')
  async getRequest(@Param('id') workspaceId: string, @Param('requestId') requestId: string) {
    const request = await this.lifecycle.getRequest(workspaceId, requestId);
    if (!request) throw new NotFoundException('data lifecycle request não encontrado');
    return request;
  }
}
