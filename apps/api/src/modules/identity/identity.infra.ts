import { createClickHouse, type ClickHouseClient } from '@truvo/db';
import Redis from 'ioredis';

/**
 * Infra memoizada do M8 (singletons de processo).
 *
 * Postgres é injetado via o provider global DRIZZLE (exposto pelo AuthModule) —
 * ver IdentityService. ClickHouse (touchpoints) e Redis (fila de stitching) não
 * têm provider global reutilizável, então ficam aqui como helpers memoizados —
 * mesma abordagem do EventsModule (`modules/events/infra.ts`).
 */

let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}

let _redis: Redis | undefined;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    _redis.on('error', (err: Error) => {
      // TODO(live): logger estruturado + alerta. Não derrubar o processo por blip do Redis.
      // eslint-disable-next-line no-console
      console.error(`[truvo/api] identity Redis error: ${err.message}`);
    });
  }
  return _redis;
}
