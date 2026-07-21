import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Auth server-to-server por SEGREDO COMPARTILHADO (`INTERNAL_API_SECRET`), para
 * chamadas internas do consumer do M2 → M8 (identify). Fail-closed: sem o env
 * configurado, NENHUMA chamada interna é aceita. Comparação em tempo constante.
 *
 * NÃO usar para tráfego de usuário (esse vai por SupabaseAuthGuard/JWT).
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) throw new UnauthorizedException('auth interno não configurado');

    const req = context.switchToHttp().getRequest<Request>();
    const provided = (req.headers['x-internal-secret'] as string | undefined) ?? '';

    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('segredo interno inválido');
    }
    return true;
  }
}
