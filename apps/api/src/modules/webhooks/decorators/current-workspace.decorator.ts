import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';

/**
 * Injeta o `workspace_id` resolvido pelo WorkspaceAuthGuard no handler.
 * Uso: `list(@CurrentWorkspace() workspaceId: string)`.
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest<{ workspaceId?: string }>();
    if (!req.workspaceId) {
      // Não deveria acontecer: o guard sempre popula antes do handler.
      throw new InternalServerErrorException('workspace não resolvido');
    }
    return req.workspaceId;
  },
);

/**
 * Injeta o `userId` resolvido pelo WorkspaceAuthGuard — usado para atribuir o ator
 * em auditoria (Order 035 §4) de mudanças de CRUD de conector (M4).
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const req = context.switchToHttp().getRequest<{ userId?: string }>();
    return req.userId;
  },
);
