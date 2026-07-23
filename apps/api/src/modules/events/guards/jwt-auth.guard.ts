import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { getSupabase, getSupabaseAdmin } from '../infra';
import type { AuthenticatedRequest } from '../types';

/**
 * JwtAuthGuard — valida o access token (JWT) do Supabase Auth (M1) e resolve o
 * workspace do painel (`x-workspace-id` header ou `?workspace_id=`).
 *
 * Usado nas rotas de leitura/gestão (recent, volume, api-keys) — nunca na
 * ingestão (essa é X-Api-Key). O `workspace_id` é obrigatório e vira `req.workspaceId`
 * para que toda query filtre por ele (regra 1).
 *
 * Enforcement multi-tenant (regra 1): confirma que `user.id` é MEMBRO de
 * `workspace_id` em `workspace_members` (via service-role, contorna RLS) — senão
 * qualquer usuário logado passaria o workspace de outro tenant e leria o stream de
 * eventos / criaria API keys dele. Mesmo critério dos demais guards.
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

    // Enforcement multi-tenant: user precisa ser membro do workspace (contorna RLS).
    const { data: members, error: memErr } = await getSupabaseAdmin()
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .limit(1);
    if (memErr) {
      throw new UnauthorizedException('Authorization check failed');
    }
    if (!members || members.length === 0) {
      throw new ForbiddenException('No access to this workspace');
    }

    req.user = { id: userId, email };
    req.workspaceId = workspaceId;
    return true;
  }
}
