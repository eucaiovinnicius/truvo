import { getRedis } from './redis';

/**
 * DEAD-LETTER de eventos que o consumer NÃO consegue processar (payload não-JSON ou
 * que falha o schema). Antes eram descartados só com console.warn — perda silenciosa,
 * sem visibilidade. Agora vão para uma lista Redis CAPADA (`truvo:dlq:events`) para
 * inspeção/replay manual, com o motivo e o instante.
 *
 * Redis (não Kafka) por simplicidade e porque o consumer já usa Redis (dedup); é o
 * suficiente p/ observabilidade em dev/MVP. // TODO(live): em produção, um TÓPICO
 * Kafka `truvo.events.dlq` (durável + reprocessável por um worker dedicado) é o
 * padrão — a interface aqui (deadLetter) isola a troca.
 */
const DLQ_KEY = 'truvo:dlq:events';
const DLQ_MAX = 1000; // mantém só as N mais recentes (evita crescer sem limite)

export async function deadLetter(reason: string, raw: string): Promise<void> {
  try {
    const redis = getRedis();
    const entry = JSON.stringify({
      reason,
      // trunca payloads gigantes p/ não estourar a lista
      raw: raw.length > 8_000 ? `${raw.slice(0, 8_000)}…[truncado ${raw.length}b]` : raw,
      at: new Date().toISOString(),
    });
    await redis.lpush(DLQ_KEY, entry);
    await redis.ltrim(DLQ_KEY, 0, DLQ_MAX - 1);
  } catch {
    // Best-effort: o DLQ nunca pode derrubar o pipeline. Se o Redis cair, o
    // console.warn do chamador ainda registra a perda.
  }
}
