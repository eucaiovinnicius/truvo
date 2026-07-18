import 'dotenv/config';
import { EventPipelineConsumer } from './consumer';

/**
 * Worker consumidor do M2 — Event Pipeline.
 * Kafka (truvo.events) → dedup (Redis) → bot → enrich → ClickHouse (batch) → contador.
 */
async function main() {
  const consumer = new EventPipelineConsumer();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[truvo/consumer] ${signal} recebido — encerrando...`);
    await consumer.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await consumer.start();
    // eslint-disable-next-line no-console
    console.log('[truvo/consumer] worker no ar');
  } catch (err) {
    // TODO(live): Redpanda/Kafka + Redis + ClickHouse no ar (docker-compose).
    // eslint-disable-next-line no-console
    console.error(`[truvo/consumer] falha ao iniciar: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
