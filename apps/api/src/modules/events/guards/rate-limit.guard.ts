import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { getRedis } from '../infra';
import type { AuthenticatedRequest } from '../types';

/**
 * RateLimitGuard — rate limit por workspace no Redis, ANTES de enfileirar (regra 8).
 *
 * Deve rodar DEPOIS do ApiKeyGuard (precisa de `req.workspaceId`). Janela fixa por
 * minuto: `ratelimit:{workspace_id}:{minuteEpoch}`. Incrementa pelo nº de eventos
 * do payload (1 no single, N no batch) — batch de 500 pesa 500. Fail-open: se o
 * Redis estiver fora, não bloqueia a ingestão (durabilidade > throttle).
 *
 * Limite via env RATE_LIMIT_EVENTS_PER_MIN (default 60000).
 * TODO(live): limite por PLANO (billing/M11) em vez de global.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limit = Number(process.env.RATE_LIMIT_EVENTS_PER_MIN ?? 60000);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const workspaceId = req.workspaceId;
    if (!workspaceId) return true; // sem workspace resolvido, o ApiKeyGuard já barrou

    const cost = Array.isArray(req.body) ? Math.max(1, req.body.length) : 1;
    const windowKey = `ratelimit:${workspaceId}:${Math.floor(Date.now() / 60000)}`;

    try {
      const redis = getRedis();
      const total = await redis.incrby(windowKey, cost);
      if (total === cost) {
        await redis.expire(windowKey, 90);
      }
      if (total > this.limit) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: `Rate limit de ${this.limit} eventos/min excedido para o workspace`,
            retryAfterSeconds: 60 - (Math.floor(Date.now() / 1000) % 60),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis fora → fail-open (não perder eventos por indisponibilidade do throttle).
      // eslint-disable-next-line no-console
      console.error(`[truvo/api] rate limit fail-open: ${(err as Error).message}`);
      return true;
    }
  }
}
