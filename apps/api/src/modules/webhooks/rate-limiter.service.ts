import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_SEC } from './constants';

/**
 * Rate limiting por workspace no Redis (regra 8) aplicado à entrada de webhooks.
 * Janela fixa (fixed window): INCR + EXPIRE. Se o Redis não estiver configurado,
 * fail-open (não bloqueia) e loga — a estrutura fica pronta para produção.
 * // TODO(live): REDIS_URL apontando para o Redis do ambiente.
 */
@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private redis: Redis | null = null;
  private disabled = false;

  private getRedis(): Redis | null {
    if (this.disabled) return null;
    if (this.redis) return this.redis;
    const url = process.env.REDIS_URL;
    if (!url) {
      this.disabled = true;
      this.logger.warn('REDIS_URL não configurada — rate limit de webhooks desabilitado (fail-open)');
      return null;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.redis.on('error', (err) => this.logger.warn(`Redis error: ${String(err)}`));
    return this.redis;
  }

  /**
   * Contabiliza um hit para o workspace na janela atual.
   * @returns allowed=false quando o limite foi excedido.
   */
  async hit(
    workspaceId: string,
    limit = WEBHOOK_RATE_LIMIT,
    windowSec = WEBHOOK_RATE_WINDOW_SEC,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const redis = this.getRedis();
    if (!redis) return { allowed: true, remaining: limit };
    try {
      const bucket = Math.floor(Date.now() / 1000 / windowSec);
      const key = `rl:webhook:${workspaceId}:${bucket}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
    } catch (err) {
      // fail-open em erro de infra: não derrubar ingestão de webhook.
      this.logger.warn(`falha no rate limit (fail-open): ${String(err)}`);
      return { allowed: true, remaining: limit };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        /* ignore */
      }
      this.redis = null;
    }
  }
}
