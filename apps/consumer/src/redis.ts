import Redis from 'ioredis';
import { structuredLog } from '@truvo/observability';

/** Client Redis compartilhado do consumer (dedup + contador de billing). */
let _redis: Redis | undefined;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    _redis.on('error', (err: Error) => {
      structuredLog('error', 'consumer_dependency_error', { dependency: 'redis', errorType: err.name });
    });
  }
  return _redis;
}
