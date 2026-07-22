import { Kafka, logLevel, type Admin } from 'kafkajs';

/**
 * Probe de saúde do Kafka/Redpanda para o /health/ready.
 *
 * A HealthController não participa do grafo de DI do EventsModule (onde vive o
 * KafkaProducerService), então mantemos aqui um Admin client memoizado e
 * dedicado. O probe é REAL (lista tópicos) mas limitado por timeout — uma
 * readiness nunca deve pendurar. Kafka é tratado como dependência NÃO-essencial
 * (não derruba o 200) — ver health.controller.ts.
 */

let _admin: Admin | undefined;
let _connected = false;

function getAdmin(): Admin {
  if (!_admin) {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);

    const kafka = new Kafka({
      clientId: 'truvo-api-health',
      brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 1 },
    });
    _admin = kafka.admin();
  }
  return _admin;
}

async function probe(): Promise<'ok'> {
  const admin = getAdmin();
  try {
    if (!_connected) {
      await admin.connect();
      _connected = true;
    }
    // chamada barata de metadados — confirma que o broker responde.
    await admin.listTopics();
    return 'ok';
  } catch (err) {
    // reset para forçar reconexão limpa na próxima checagem.
    _connected = false;
    _admin = undefined;
    await admin.disconnect().catch(() => undefined);
    throw err;
  }
}

/**
 * Retorna 'ok' se o broker responde dentro de `timeoutMs`, senão 'down'.
 * Nunca lança e nunca pendura (timeout embutido).
 */
export async function pingKafka(timeoutMs = 2000): Promise<'ok' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => resolve('down'), timeoutMs);
  });
  // `.catch` garante que a promessa sempre resolve (sem unhandled rejection se o timeout vencer).
  const attempt = probe().catch(() => 'down' as const);

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
