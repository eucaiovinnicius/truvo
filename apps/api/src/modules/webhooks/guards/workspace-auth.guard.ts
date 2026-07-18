import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
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
 * // TODO(live): validar a associação usuário↔workspace contra `workspace_members`
 * (M1). Enquanto o M1 não expõe a tabela, confiamos no header já autenticado —
 * este é o único ponto que precisa ser fechado antes de produção.
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

    req.userId = userId;
    req.workspaceId = workspaceId;
    return true;
  }
}
