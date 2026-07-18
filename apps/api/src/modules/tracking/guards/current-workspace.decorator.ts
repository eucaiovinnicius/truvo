import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Contexto de workspace resolvido pelo WorkspaceAuthGuard e anexado à request. */
export interface WorkspaceContext {
  id: string;
  userId: string;
}

/**
 * Injeta o workspace autenticado no handler:
 *   @CurrentWorkspace() ws: WorkspaceContext
 * Sempre usado junto de @UseGuards(WorkspaceAuthGuard).
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const req = ctx.switchToHttp().getRequest<{ workspace?: WorkspaceContext }>();
    if (!req.workspace) {
      // Não deveria acontecer se o guard rodou; sinaliza erro de fiação.
      throw new Error('WorkspaceContext ausente — WorkspaceAuthGuard não executou');
    }
    return req.workspace;
  },
);
