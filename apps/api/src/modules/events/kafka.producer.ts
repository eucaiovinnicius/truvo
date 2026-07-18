import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Kafka, Producer, logLevel, type Message } from 'kafkajs';

/**
 * Producer Kafka (Redpanda em dev). É a fronteira de durabilidade da ingestão:
 * `POST /v1/events` valida → publica aqui → retorna 200 (regra 9). Todo o
 * processamento pesado (dedup/enrich/insert) acontece DEPOIS, no consumer.
 *
 * O `send` é aguardado (é rápido) — se o Kafka estiver fora, respondemos 503 em
 * vez de aceitar e perder o evento. "Async" = o que vem depois do Kafka, não o publish.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: Producer;
  private connected = false;

  readonly topic = process.env.KAFKA_EVENTS_TOPIC ?? 'truvo.events';

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);

    const kafka = new Kafka({
      clientId: 'truvo-api',
      brokers,
      logLevel: logLevel.ERROR,
      retry: { retries: 3 },
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: true });
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect().catch(() => undefined);
      this.connected = false;
    }
  }

  private async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.connected = true;
      this.logger.log(`Kafka producer conectado (topic=${this.topic})`);
    } catch (err) {
      this.connected = false;
      // TODO(live): Redpanda/Kafka no ar (docker-compose) + retry/backoff de conexão.
      this.logger.error(`Kafka producer indisponível: ${(err as Error).message}`);
    }
  }

  /** Publica N mensagens no tópico de eventos. Lança 503 se o Kafka estiver fora. */
  async publish(messages: Message[]): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    if (!this.connected) {
      throw new ServiceUnavailableException('Event pipeline temporariamente indisponível (Kafka)');
    }
    try {
      await this.producer.send({ topic: this.topic, messages });
    } catch (err) {
      this.connected = false;
      throw new ServiceUnavailableException(`Falha ao enfileirar evento: ${(err as Error).message}`);
    }
  }
}
