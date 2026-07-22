import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Guard de autenticação dos endpoints de gerência de integrações
 * (`/v1/integrations/*`). Valida o JWT do Supabase (Bearer) e escopa a
 * requisição a um `workspace_id` (header `x-workspace-id`).
 *
 * A `SUPABASE_SERVICE_ROLE_KEY` é usada APENAS aqui no backend (regra 3 — nunca
 * vai ao frontend). Anexa `workspaceId`/`userId` ao request.
 *
 * Enforcement multi-tenant (regra 1): valida a associação usuário↔workspace contra
 * `workspace_members` (service-role contorna RLS) — sem membership → 403.
 */
@Injectable()
export class WorkspaceAuthGuard implements CanActivate {
  private readonly logger = new Logger(WorkspaceAuthGuard.name);
  private client?: SupabaseClient;

  private getClient(): SupabaseClient {
    if (this.client) return this.client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      // TODO(live): configurar SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
      throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configuradas (ver .env.example)');
    }
    this.client = createClient(url, key, { auth: { persistSession: false } });
    return this.client;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      workspaceId?: string;
      userId?: string;
    }>();

    const authHeader = req.headers['authorization'];
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;
    if (!token) {
      throw new UnauthorizedException('token Bearer ausente');
    }

    let userId: string;
    try {
      const { data, error } = await this.getClient().auth.getUser(token);
      if (error || !data?.user) {
        throw new UnauthorizedException('token inválido');
      }
      userId = data.user.id;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(`falha ao validar token no Supabase: ${String(err)}`);
      throw new UnauthorizedException('falha na autenticação');
    }

    const workspaceId = req.headers['x-workspace-id'];
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new BadRequestException('header x-workspace-id obrigatório');
    }

    // Enforcement multi-tenant (regra 1): confirma que o usuário é MEMBRO do
    // workspace do header (service-role contorna RLS). Mesmo critério do M1.
    const { data: members, error: memErr } = await this.getClient()
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .limit(1);
    if (memErr) {
      this.logger.error(`falha ao checar membership: ${memErr.message}`);
      throw new UnauthorizedException('falha na autorização');
    }
    if (!members || members.length === 0) {
      throw new ForbiddenException('Sem acesso a este workspace');
    }

    req.userId = userId;
    req.workspaceId = workspaceId;
    return true;
  }
}
