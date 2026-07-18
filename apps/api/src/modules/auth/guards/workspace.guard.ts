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
import { DRIZZLE, type Database } from '../database.provider';
import { ROLES_KEY, type AuthUser } from '../decorators';
import type { WorkspaceRole } from '../roles';

/**
 * WorkspaceGuard — roda DEPOIS do SupabaseAuthGuard. Resolve o workspace da rota
 * (param `:id` ou header `x-workspace-id`), confirma que `request.user` é membro
 * e injeta `request.workspace = { id, role }`.
 *
 * Enforcement multi-tenant (regra 1): sem membership → 403. Se a rota declara
 * @Roles(...), valida o papel do membro contra a lista exigida (PRD §7 M1).
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      params?: Record<string, string>;
      headers: Record<string, string | undefined>;
      workspace?: { id: string; role: WorkspaceRole };
    }>();

    const user = req.user;
    if (!user) {
      // SupabaseAuthGuard deve rodar antes deste guard.
      throw new ForbiddenException('Não autenticado');
    }

    const workspaceId = req.params?.id ?? req.headers['x-workspace-id'];
    if (!workspaceId) {
      throw new BadRequestException('workspace_id ausente (param :id ou header x-workspace-id)');
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

    req.workspace = { id: workspaceId, role: membership.role };

    const required = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && !required.includes(membership.role)) {
      throw new ForbiddenException('Permissão insuficiente para esta ação');
    }

    return true;
  }
}
