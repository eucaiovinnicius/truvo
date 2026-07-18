import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from './roles';

/**
 * Decorators compartilhados do M1. Os OUTROS módulos importam DESTE caminho exato:
 *   import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
 */

/** Usuário autenticado, injetado por SupabaseAuthGuard em `request.user`. */
export interface AuthUser {
  id: string;
  email?: string;
}

/** Contexto de workspace, injetado por WorkspaceGuard em `request.workspace`. */
export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
}

/**
 * @CurrentUser() → AuthUser | @CurrentUser('id') → string
 * Requer SupabaseAuthGuard na rota/controller.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);

/**
 * @CurrentWorkspace() → WorkspaceContext | @CurrentWorkspace('role') → WorkspaceRole
 * Requer WorkspaceGuard na rota (resolve membership + papel).
 */
export const CurrentWorkspace = createParamDecorator(
  (field: keyof WorkspaceContext | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ workspace?: WorkspaceContext }>();
    const ws = req.workspace;
    if (!ws) return undefined;
    return field ? ws[field] : ws;
  },
);

/** Chave de metadata para papéis exigidos numa rota. */
export const ROLES_KEY = 'truvo:roles';

/**
 * @Roles('owner','admin') — restringe a rota aos papéis dados.
 * Enforced pelo WorkspaceGuard (que já resolve o papel do usuário no workspace).
 */
export const Roles = (...roles: WorkspaceRole[]) => SetMetadata(ROLES_KEY, roles);
