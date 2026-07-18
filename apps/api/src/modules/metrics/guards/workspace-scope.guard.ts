import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { workspaceMembers } from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { ROLES_KEY, type AuthUser, type WorkspaceContext } from '../../auth/decorators';
import type { WorkspaceRole } from '../../auth/roles';

/**
 * WorkspaceScopeGuard — resolução de workspace do M6.
 *
 * POR QUE NÃO reusar `WorkspaceGuard` (M1) direto: aquele guard resolve o workspace
 * a partir do param de rota `:id` (ou header). Aqui `:id` é o id de um RECURSO
 * (dashboard/kpi), NÃO o workspace — usá-lo trataria o id do recurso como tenant.
 * Então este guard resolve o workspace SOMENTE do header `x-workspace-id`
 * (ou `?workspace_id=`), nunca de `:id`.
 *
 * Reaproveita o resto do M1: roda DEPOIS de `SupabaseAuthGuard` (que autentica e
 * seta `req.user`), confere membership em `workspace_members` pela conexão DRIZZLE
 * global (@Global do AuthModule) e injeta `req.workspace = { id, role }` — mesma
 * forma que o `@CurrentWorkspace()` do M1 espera. Enforce de `@Roles(...)` idêntico.
 *
 * Regra 1: sem membership → 403; o workspace resolvido é usado em toda query.
 */
@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      headers: Record<string, string | string[] | undefined>;
      query?: Record<string, unknown>;
      workspace?: WorkspaceContext;
    }>();

    const user = req.user;
    if (!user) {
      // SupabaseAuthGuard deve rodar antes deste guard (ordem em @UseGuards).
      throw new ForbiddenException('Não autenticado');
    }

    const workspaceId = readHeader(req.headers['x-workspace-id']) || readQuery(req.query?.workspace_id);
    if (!workspaceId) {
      throw new BadRequestException('workspace ausente (header x-workspace-id ou ?workspace_id=)');
    }

    const rows = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      )
      .limit(1);

    const membership = rows[0];
    if (!membership) {
      throw new ForbiddenException('Sem acesso a este workspace');
    }

    req.workspace = { id: workspaceId, role: membership.role as WorkspaceRole };

    const required = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && !required.includes(membership.role as WorkspaceRole)) {
      throw new ForbiddenException('Permissão insuficiente para esta ação');
    }

    return true;
  }
}

function readHeader(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return (v[0] ?? '').trim();
  return (v ?? '').trim();
}

function readQuery(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
