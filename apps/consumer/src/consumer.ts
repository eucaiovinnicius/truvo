import { Kafka, type Consumer, logLevel } from 'kafkajs';
import { eventSchema, type TruvoEvent } from '@truvo/event-schema';
import { isFirstSeen, resolveOrderId } from './dedup';
import { detectBot } from './bot-filter';
import { enrich } from './enrich';
import { ClickHouseBatcher, buildRow } from './clickhouse-batch';
import { incrementMonthlyCounter } from './billing-counter';
import { getRedis } from './redis';
import { identifyRequestFromEvent } from './identity/event-hook';
import { conversionForwardFromEvent } from './conversion-hook';
import { buildProjectionRequest } from './context-projection-hook';
import { deadLetter } from './dlq';
import { classifyFailure, metrics, structuredLog } from '@truvo/observability';

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
    structuredLog('info', 'consumer_started', { topic: TOPIC, group: GROUP_ID });

    await this.consumer.run({
      // Flush do ClickHouse acontece dentro do handler; offsets só resolvem se o
      // handler completar sem lançar → em falha de insert, o batch reprocessa
      // (dedup por event_id + ReplacingMergeTree tornam o reprocesso idempotente).
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        for (const message of batch.messages) {
          if (!isRunning() || isStale()) break;
          if (message.value) {
            await this.handle(message.value.toString(), message.key?.toString());
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
  private async handle(rawValue: string, correlationId?: string): Promise<void> {
    let event: TruvoEvent;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(rawValue));
      if (!parsed.success) {
        // Dead-letter em vez de perda silenciosa (inspeção/replay depois).
        await deadLetter(`schema_invalido: ${parsed.error.issues[0]?.message ?? 'inválido'}`, rawValue);
        metrics.increment('ingestion_rejected_total', { reason: 'schema' });
        structuredLog('warn', 'consumer_event_rejected', { reason: 'schema' });
        return;
      }
      event = parsed.data;
    } catch {
      await deadLetter('payload_nao_json', rawValue);
      metrics.increment('ingestion_rejected_total', { reason: 'json' });
      structuredLog('warn', 'consumer_event_rejected', { reason: 'json' });
      return;
    }

    // 2. dedup por event_id (24h)
    if (!(await isFirstSeen(event.event_id))) {
      return; // duplicata dentro da janela — ignora
    }

    // 3. dedup por order_id (prioridade de fonte)
    const decision = await resolveOrderId(event);
    if (!decision.winner) {
      structuredLog('info', 'consumer_order_deduplicated', {
        source: event.source,
        incumbentSource: decision.incumbentSource,
      });
      return; // conversão de fonte menos confiável — descartada (regra 2)
    }

    // 4. bot
    const isBot = detectBot(event);

    // 5. enrich (device + geo). IP é descartado aqui — nunca persistido (regra 5).
    const enriched = enrich(event);

    // 6. batch insert
    await this.batcher.add(buildRow(event, enriched, isBot));
    metrics.increment('consumer_events_processed_total', { bot: isBot ? 'true' : 'false' });

    // 7. contador mensal — SÓ não-bot conta p/ billing (regra 11)
    if (!isBot) {
      await incrementMonthlyCounter(event);
    }

    // 8/9/10. wirings server-to-server (só não-bot, best-effort):
    //   M2×M8 → constrói o grafo de identidade a partir do evento (roda primeiro:
    //     Order 040 precisa do canonical_id resolvido antes de projetar);
    //   M2×M9 → encaminha conversões (purchase/lead/…) p/ as plataformas habilitadas;
    //   M2×Order 30 → projeta o evento em outcome/trait canônico, quando há regra.
    if (!isBot) {
      const cid = correlationId ?? event.event_id;
      const canonicalId = await forwardIdentity(event, cid);
      await Promise.all([forwardConversion(event, cid), forwardProjection(event, canonicalId, cid)]);
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
 *
 * Devolve o `canonical_id` resolvido (Order 040 §3: `identify()` já espelha o
 * resultado em `customers` via `synchronizeLegacyIdentity` antes de responder —
 * por isso a projeção que roda em seguida pode confiar que a linha existe).
 */
async function forwardIdentity(event: TruvoEvent, correlationId: string): Promise<string | undefined> {
  if (!INTERNAL_API_SECRET) return undefined;
  const req = identifyRequestFromEvent(event);
  if (!req) return undefined;
  const res = await postInternalJson<{ canonical_id: string }>(
    '/v1/internal/identity/identify',
    req,
    correlationId,
  );
  return res?.canonical_id;
}

/**
 * Fecha o wiring M2×Order 30: projeta o evento (quando há regra conhecida — ver
 * `outcome-projection.registry.ts` na API) em outcome/trait canônico. Best-effort,
 * mesmo padrão dos demais forwards internos; sem `canonical_id` resolvido (identify
 * falhou/não se aplicou), não há em que anexar o outcome — no-op silencioso.
 */
async function forwardProjection(event: TruvoEvent, canonicalId: string | undefined, correlationId: string): Promise<void> {
  if (!INTERNAL_API_SECRET) return;
  const req = buildProjectionRequest(event, canonicalId);
  if (!req) return;
  await postInternal('/v1/internal/context/project', req, correlationId, 'context_projection');
}

/**
 * Fecha o wiring M2×M9: em cada conversão (purchase/lead/…), encaminha para o
 * endpoint interno que envia server-side às plataformas habilitadas (Meta CAPI /
 * Google / TikTok / HubSpot). Best-effort — nunca derruba o pipeline; o forwarder
 * é fail-closed (sem plataforma/consentimento/match key não envia). Sem
 * `INTERNAL_API_SECRET`, o forward fica desligado (dev).
 */
async function forwardConversion(event: TruvoEvent, correlationId: string): Promise<void> {
  if (!INTERNAL_API_SECRET) return;
  const input = conversionForwardFromEvent(event);
  if (!input) return;
  await postInternal('/v1/internal/conversions/forward', input, correlationId);
}

/**
 * POST server-to-server best-effort (timeout 4s, segredo interno). Nunca lança.
 * `module` rotula a métrica/log (default preserva o rótulo original dos forwards
 * de identity/conversion já existentes); `reason` (Order 040 §4: falha observável
 * com motivo/correlação/workspace) foi adicionado ao log — só enriquece o schema,
 * nenhum campo existente muda de forma ou é removido.
 */
async function postInternal(path: string, body: unknown, correlationId: string, module = 'internal_forward'): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(`${INTERNAL_API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET as string, 'x-request-id': correlationId },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    const failure = classifyFailure(error);
    metrics.increment('connector_failures_total', { module, kind: failure.kind });
    structuredLog('warn', 'internal_forward_failed', { module, retryable: failure.kind === 'transient', correlationId, reason: failure.reason });
  }
}

/**
 * Variante de `postInternal` que devolve o corpo (JSON) da resposta em vez de
 * descartá-lo — só usada por `forwardIdentity`, que precisa do `canonical_id`
 * resolvido para encadear a projeção (Order 040 §3). Resposta não-2xx devolve
 * `undefined` sem log (mesmo comportamento pré-existente de `postInternal`, que
 * nunca checava `res.ok`); falha de rede é classificada/logada como antes.
 */
async function postInternalJson<T>(path: string, body: unknown, correlationId: string): Promise<T | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${INTERNAL_API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET as string, 'x-request-id': correlationId },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch (error) {
    const failure = classifyFailure(error);
    metrics.increment('connector_failures_total', { module: 'internal_forward', kind: failure.kind });
    structuredLog('warn', 'internal_forward_failed', { module: 'internal_forward', retryable: failure.kind === 'transient', correlationId, reason: failure.reason });
    return undefined;
  }
}
