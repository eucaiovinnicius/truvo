import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase.provider';

/**
 * SupabaseAuthGuard — valida o JWT do Supabase (header `Authorization: Bearer <jwt>`)
 * e injeta `request.user = { id, email }` + `request.accessToken`.
 *
 * Os OUTROS módulos usam DESTE caminho exato:
 *   @UseGuards(SupabaseAuthGuard)
 *
 * TODO(live): valida via `supabase.auth.getUser(jwt)` (round-trip ao Supabase).
 * Em produção, trocar por verificação local do JWT (jose + SUPABASE_JWT_SECRET)
 * para cortar latência por request — mantendo a mesma forma de `request.user`.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
      accessToken?: string;
    }>();

    const token = this.extractToken(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Bearer token ausente');
    }

    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw new UnauthorizedException('Token inválido ou expirado');
    }

    req.user = { id: data.user.id, email: data.user.email };
    req.accessToken = token;
    return true;
  }

  private extractToken(authorization?: string): string | null {
    if (!authorization) return null;
    const [scheme, token] = authorization.split(' ');
    return scheme === 'Bearer' && token ? token : null;
  }
}
