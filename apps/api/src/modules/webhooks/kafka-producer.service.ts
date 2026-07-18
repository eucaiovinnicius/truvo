import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, logLevel, type Producer } from 'kafkajs';

/**
 * Produtor Kafka do módulo de webhooks.
 *
 * NOTA DE INTEGRAÇÃO: este provider é LOCAL ao M4. Na integração com o M2
 * (Event Pipeline), deve ser UNIFICADO com o KafkaProducer do M2 (mesmo
 * cliente/config, mesmo tópico `truvo.events`) e movido para um módulo
 * compartilhado. Mantido aqui para o M4 ser autossuficiente. // TODO(live)
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private connected = false;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    this.kafka = new Kafka({
      clientId: 'truvo-webhooks',
      brokers,
      logLevel: logLevel.ERROR,
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) {
      try {
        await this.producer.disconnect();
      } catch (err) {
        this.logger.warn(`erro ao desconectar producer: ${String(err)}`);
      }
      this.connected = false;
    }
  }

  private async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.connected = true;
    } catch (err) {
      // TODO(live): Kafka/Redpanda precisa estar no ar (KAFKA_BROKERS).
      // Sem conexão, publish() lança e o webhook cai no fluxo de retry.
      this.logger.warn(`Kafka indisponível na inicialização: ${String(err)}`);
    }
  }

  /** Publica um evento no tópico. Lança em falha (o chamador agenda retry). */
  async publish(topic: string, key: string, value: unknown): Promise<void> {
    if (!this.connected) {
      await this.connect();
      if (!this.connected) {
        throw new Error('Kafka producer não conectado');
      }
    }
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }
}
