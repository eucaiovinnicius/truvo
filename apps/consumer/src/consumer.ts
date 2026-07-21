import { Kafka, type Consumer, logLevel } from 'kafkajs';
import { eventSchema, type TruvoEvent } from '@truvo/event-schema';
import { isFirstSeen, resolveOrderId } from './dedup';
import { detectBot } from './bot-filter';
import { enrich } from './enrich';
import { ClickHouseBatcher, buildRow } from './clickhouse-batch';
import { incrementMonthlyCounter } from './billing-counter';
import { getRedis } from './redis';
import { identifyRequestFromEvent } from './identity/event-hook';

const TOPIC = process.env.KAFKA_EVENTS_TOPIC ?? 'truvo.events';
const GROUP_ID = process.env.CONSUMER_GROUP_ID ?? 'truvo-consumer';

/**
 * Consumer do Event Pipeline (PRD §7 M2, "Lógica do consumer"):
 *   1. consome do Kafka
 *   2. dedup por event_id (Redis, TTL 24h)
 *   3. dedup por order_id (prioridade de fonte)
 *   4. filtra bot → marca is_bot
 *   5. enriquece (device + geo)
 *   6. batch insert no ClickHouse (100 ou 1s)
 *   7. incrementa contador mensal (só não-bot)
 */
export class EventPipelineConsumer {
  private readonly consumer: Consumer;
  private readonly batcher = new ClickHouseBatcher();

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);

    const kafka = new Kafka({
      clientId: 'truvo-consumer',
      brokers,
      logLevel: logLevel.ERROR,
      retry: { retries: 5 },
    });
    this.consumer = kafka.consumer({ groupId: GROUP_ID });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPIC, fromBeginning: false });
    // eslint-disable-next-line no-console
    console.log(`[truvo/consumer] consumindo topic=${TOPIC} group=${GROUP_ID}`);

    await this.consumer.run({
      // Flush do ClickHouse acontece dentro do handler; offsets só resolvem se o
      // handler completar sem lançar → em falha de insert, o batch reprocessa
      // (dedup por event_id + ReplacingMergeTree tornam o reprocesso idempotente).
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        for (const message of batch.messages) {
          if (!isRunning() || isStale()) break;
          if (message.value) {
            await this.handle(message.value.toString());
          }
          resolveOffset(message.offset);
          await heartbeat();
        }
        // Garante que tudo que entrou no buffer foi inserido antes do commit.
        await this.batcher.flush();
      },
    });
  }

  /** Processa uma mensagem crua (passos 2..7). */
  private async handle(rawValue: string): Promise<void> {
    let event: TruvoEvent;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(rawValue));
      if (!parsed.success) {
        // TODO(live): mandar p/ dead-letter topic com o erro de validação.
        // eslint-disable-next-line no-console
        console.warn('[truvo/consumer] evento inválido descartado');
        return;
      }
      event = parsed.data;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[truvo/consumer] payload não-JSON descartado');
      return;
    }

    // 2. dedup por event_id (24h)
    if (!(await isFirstSeen(event.event_id))) {
      return; // duplicata dentro da janela — ignora
    }

    // 3. dedup por order_id (prioridade de fonte)
    const decision = await resolveOrderId(event);
    if (!decision.winner) {
      // eslint-disable-next-line no-console
      console.log(
        `[truvo/consumer] descarte order_id=${event.order_id}: fonte '${event.source}' perde p/ '${decision.incumbentSource}'`,
      );
      return; // conversão de fonte menos confiável — descartada (regra 2)
    }

    // 4. bot
    const isBot = detectBot(event);

    // 5. enrich (device + geo). IP é descartado aqui — nunca persistido (regra 5).
    const enriched = enrich(event);

    // 6. batch insert
    await this.batcher.add(buildRow(event, enriched, isBot));

    // 7. contador mensal — SÓ não-bot conta p/ billing (regra 11)
    if (!isBot) {
      await incrementMonthlyCounter(event);
    }

    // 8. wiring M2×M8: constrói o grafo de identidade a partir do evento (só não-bot).
    if (!isBot) {
      await forwardIdentity(event);
    }
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect().catch(() => undefined);
    await this.batcher.close().catch(() => undefined);
    await getRedis().quit().catch(() => undefined);
  }
}

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3333';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

/**
 * Fecha o wiring M2×M8: para eventos com identificador (purchase / user_id /
 * order_id / email_hash...), chama o endpoint INTERNO de identify na API (que tem
 * Drizzle) para construir/atualizar o grafo de identidade. Best-effort — nunca
 * derruba o pipeline (o merge no Postgres é reconciliável por replay/backfill).
 * Sem `INTERNAL_API_SECRET` no ambiente, o forward fica desligado (dev).
 */
async function forwardIdentity(event: TruvoEvent): Promise<void> {
  if (!INTERNAL_API_SECRET) return;
  const req = identifyRequestFromEvent(event);
  if (!req) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(`${INTERNAL_API_URL}/v1/internal/identity/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    /* best-effort */
  }
}
