import type { TruvoEvent } from '@truvo/event-schema';
import { getRedis } from './redis';

/**
 * Contador mensal de eventos por workspace no Redis — insumo de billing e feature
 * gates (M11). Regra 11: SÓ eventos não-bot contam. A chave é particionada por
 * mês (YYYYMM) do timestamp do evento, com TTL de segurança de ~13 meses.
 */
export async function incrementMonthlyCounter(event: TruvoEvent): Promise<void> {
  const ts = event.timestamp ? new Date(event.timestamp) : new Date();
  const yyyymm = `${ts.getUTCFullYear()}${String(ts.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `billing:events:${event.workspace_id}:${yyyymm}`;

  const redis = getRedis();
  const total = await redis.incr(key);
  if (total === 1) {
    await redis.expire(key, 60 * 60 * 24 * 400); // ~13 meses
  }
}
