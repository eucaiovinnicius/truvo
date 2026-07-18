import Redis from 'ioredis';

/** Client Redis compartilhado do consumer (dedup + contador de billing). */
let _redis: Redis | undefined;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    _redis.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[truvo/consumer] Redis error: ${err.message}`);
    });
  }
  return _redis;
}
