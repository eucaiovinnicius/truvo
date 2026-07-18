import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { getSupabase } from '../infra';
import type { AuthenticatedRequest } from '../types';

/**
 * JwtAuthGuard — valida o access token (JWT) do Supabase Auth (M1) e resolve o
 * workspace do painel (`x-workspace-id` header ou `?workspace_id=`).
 *
 * Usado nas rotas de leitura/gestão (recent, volume, api-keys) — nunca na
 * ingestão (essa é X-Api-Key). O `workspace_id` é obrigatório e vira `req.workspaceId`
 * para que toda query filtre por ele (regra 1).
 *
 * TODO(live): confirmar que `user.id` é membro de `workspace_id` consultando
 * `workspace_members` do M1 (Auth) — pertence ao módulo de auth, que roda em paralelo.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    let userId: string;
    let email: string | undefined;
    try {
      const { data, error } = await getSupabase().auth.getUser(token);
      if (error || !data?.user) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      userId = data.user.id;
      email = data.user.email ?? undefined;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Supabase inatingível/mal configurado.
      throw new UnauthorizedException('Auth verification failed');
    }

    const workspaceId =
      (req.header('x-workspace-id') ?? (req.query?.workspace_id as string | undefined))?.trim();
    if (!workspaceId) {
      throw new BadRequestException('Missing workspace context (x-workspace-id header or ?workspace_id=)');
    }

    req.user = { id: userId, email };
    req.workspaceId = workspaceId;
    return true;
  }
}
