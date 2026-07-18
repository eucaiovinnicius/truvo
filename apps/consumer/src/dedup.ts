import type { TruvoEvent } from '@truvo/event-schema';
import { SOURCE_PRIORITY, EVENT_SOURCES, type EventSource } from '@truvo/event-schema';
import { getRedis } from './redis';

const EVENT_DEDUP_TTL_SECONDS = Number(process.env.EVENT_ID_DEDUP_TTL ?? 86400); // 24h

/**
 * Dedup por `event_id` (idempotência). Janela de 24h no Redis (TTL).
 * Retorna `true` se este é o PRIMEIRO avistamento (deve processar), `false` se
 * já foi visto na janela (descartar). SET NX é atômico → sem corrida entre
 * partições/instâncias.
 *
 * ⚠️ Duplicatas que chegam após 24h escapam desta camada — por isso o
 * ReplacingMergeTree(event_id) no ClickHouse é a rede de segurança final.
 */
export async function isFirstSeen(eventId: string): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(`dedup:evt:${eventId}`, '1', 'EX', EVENT_DEDUP_TTL_SECONDS, 'NX');
  return res === 'OK';
}

function priorityOf(source: string): number {
  const p = SOURCE_PRIORITY[source as EventSource];
  // fonte desconhecida = menos confiável que qualquer conhecida
  return p ?? EVENT_SOURCES.length;
}

export interface OrderDedupDecision {
  /** este evento é o vencedor atual para o order_id (deve inserir)? */
  winner: boolean;
  /** fonte que já havia vencido (quando este perde) — p/ log de descarte. */
  incumbentSource?: string;
}

/**
 * Dedup por `order_id` com prioridade de fonte (regra 2): webhook > api > gateway
 * > redirect > pixel > url. SEM janela de tempo — comparação persistente.
 *
 * Guarda no Redis o menor índice de prioridade (= fonte mais confiável) já visto
 * para o order_id daquele workspace. Um evento é vencedor se sua fonte é
 * estritamente mais confiável do que a incumbente (ou se é a primeira). Empate de
 * fonte → mantém a incumbente (idempotência já cobre o mesmo event_id).
 *
 * Feito com WATCH/MULTI (CAS otimista) p/ ser seguro sob concorrência.
 */
export async function resolveOrderId(event: TruvoEvent): Promise<OrderDedupDecision> {
  if (!event.order_id) return { winner: true };

  const redis = getRedis();
  const key = `dedup:order:${event.workspace_id}:${event.order_id}`;
  const incomingPriority = priorityOf(event.source);

  // retry curto do CAS
  for (let attempt = 0; attempt < 5; attempt++) {
    await redis.watch(key);
    const raw = await redis.get(key); // formato: "<priority>|<source>|<event_id>"
    const incumbentPriority = raw ? Number(raw.split('|')[0]) : Number.POSITIVE_INFINITY;
    const incumbentSource = raw ? raw.split('|')[1] : undefined;

    if (incomingPriority >= incumbentPriority) {
      await redis.unwatch();
      return { winner: false, incumbentSource };
    }

    const value = `${incomingPriority}|${event.source}|${event.event_id}`;
    const tx = redis.multi().set(key, value);
    const execResult = await tx.exec(); // null se a key mudou desde o WATCH
    if (execResult !== null) {
      return { winner: true, incumbentSource };
    }
    // conflito → tenta de novo
  }

  // fallback conservador após esgotar tentativas: trata como vencedor
  // (o ReplacingMergeTree + dedup de order_id na leitura são a rede final).
  return { winner: true };
}
