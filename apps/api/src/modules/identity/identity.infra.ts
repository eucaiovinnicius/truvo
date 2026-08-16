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

/**
 * Fecha o singleton de Redis deste módulo. O app de longa duração (NestJS) NUNCA
 * chama isto — a conexão vive com o processo. Necessário só para scripts/testes de
 * vida curta: sem Redis alcançável, o client do ioredis fica reconectando
 * indefinidamente em background (retryStrategy da lib, independente de
 * `maxRetriesPerRequest`) e mantém o event loop vivo para sempre — mesma classe de
 * defeito que `closeDb()` (@truvo/db) resolveu para o pool do Postgres na
 * verificação em runtime do Order 035, agora exposta no Redis por
 * `event-projection.tenant-isolation.test.ts` (Order 040), o primeiro teste
 * real-Postgres a de fato chamar `IdentityService.identify()` (que aciona
 * `enqueueRetroStitch` via `getRedis()` quando há merge).
 */
export function closeRedis(): void {
  if (!_redis) return;
  const client = _redis;
  _redis = undefined;
  // disconnect() (não quit()): não faz round-trip de rede — evita esperar por uma
  // resposta de um Redis que pode nem estar alcançável (é exatamente o cenário que
  // este helper existe para encerrar).
  client.disconnect();
}
