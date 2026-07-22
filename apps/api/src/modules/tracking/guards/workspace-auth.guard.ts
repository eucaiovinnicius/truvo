import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceContext } from './current-workspace.decorator';

/**
 * Autentica endpoints de dashboard (JWT do Supabase) e resolve o workspace-alvo
 * a partir do header `x-workspace-id`.
 *
 * Regras respeitadas:
 *  - Regra 1: o workspace resolvido é usado em TODA query do serviço (filtro obrigatório).
 *  - Regra 3: usa a SERVICE_ROLE apenas no backend; jamais exposta ao front.
 *
 * Enforcement multi-tenant (regra 1): valida a associação usuário↔workspace contra
 * `workspace_members` (service-role contorna RLS) — sem membership → 403. O escape
 * hatch TRUVO_DEV_AUTH_BYPASS só vale fora de produção (NODE_ENV != production).
 */
@Injectable()
export class WorkspaceAuthGuard implements CanActivate {
  private readonly logger = new Logger(WorkspaceAuthGuard.name);
  private supabase: SupabaseClient | null = null;
  private initialized = false;

  private client(): SupabaseClient | null {
    if (this.initialized) return this.supabase;
    this.initialized = true;
    const url = process.env.SUPABASE_URL;
    // SERVICE_ROLE fica só no servidor (regra 3); cai p/ ANON se for o que existe.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      this.logger.warn('SUPABASE_URL/KEY ausentes — auth de tracking indisponível (ver .env.example)');
      return null;
    }
    this.supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return this.supabase;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      workspace?: WorkspaceContext;
    }>();

    const workspaceId = header(req.headers['x-workspace-id']);
    if (!workspaceId) {
      throw new BadRequestException('header x-workspace-id é obrigatório');
    }

    // Escape hatch de dev (OFF por padrão): permite testar sem Supabase no ar.
    // Fail-safe: NUNCA vale em produção, mesmo que a env vaze ligada.
    if (process.env.TRUVO_DEV_AUTH_BYPASS === '1' && process.env.NODE_ENV !== 'production') {
      this.logger.warn('TRUVO_DEV_AUTH_BYPASS=1 — pulando validação de JWT (apenas dev)');
      req.workspace = { id: workspaceId, userId: 'dev-bypass' };
      return true;
    }

    const token = bearer(req.headers['authorization']);
    if (!token) throw new UnauthorizedException('token Bearer ausente');

    const supabase = this.client();
    if (!supabase) {
      throw new UnauthorizedException('backend de autenticação não configurado (SUPABASE_URL/KEY)');
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw new UnauthorizedException('token inválido ou expirado');
    }

    // Enforcement multi-tenant (regra 1): o usuário autenticado precisa ser MEMBRO
    // do workspace do header — senão qualquer usuário logado veria outro tenant.
    // Lê via service-role (contorna RLS); mesmo critério do WorkspaceGuard (M1).
    const { data: members, error: memErr } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', data.user.id)
      .limit(1);
    if (memErr) {
      this.logger.error(`falha ao checar membership: ${memErr.message}`);
      throw new UnauthorizedException('falha na autorização');
    }
    if (!members || members.length === 0) {
      throw new ForbiddenException('Sem acesso a este workspace');
    }

    req.workspace = { id: workspaceId, userId: data.user.id };
    return true;
  }
}

function header(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return (v[0] ?? '').trim();
  return (v ?? '').trim();
}

function bearer(v: string | string[] | undefined): string | null {
  const h = header(v);
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim() || null;
}
