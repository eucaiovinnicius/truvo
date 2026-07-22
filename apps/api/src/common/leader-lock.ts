import { ulid } from 'ulid';
import { getRedis } from '../modules/events/infra';

/**
 * Executa `fn` em NO MÁXIMO uma instância por vez (leader único), via lock Redis
 * `SET key token PX ttl NX`. Em múltiplas réplicas, só quem adquire o lock roda o
 * job — evita sweeps/relatórios duplicados. Fail-safe: se o Redis estiver
 * indisponível, NÃO roda (retorna false) — melhor pular um tick do que duplicar sem
 * coordenação. Libera o lock com CAS (só se ainda for nosso); o TTL é a rede de
 * segurança se a instância morrer no meio.
 *
 * @returns true se ESTA instância adquiriu o lock e rodou `fn`; false se outra
 *          instância já detinha o lock (ou o Redis falhou).
 */
export async function withLeaderLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const redis = getRedis();
  const token = ulid();

  let acquired: string | null;
  try {
    acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  } catch {
    return false; // sem Redis não há coordenação → não roda (evita duplicar)
  }
  if (acquired !== 'OK') return false;

  try {
    await fn();
  } finally {
    // Libera SÓ se o valor ainda for o nosso (CAS via Lua) — nunca apaga lock alheio.
    try {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      );
    } catch {
      /* melhor esforço; o TTL expira o lock sozinho */
    }
  }
  return true;
}
