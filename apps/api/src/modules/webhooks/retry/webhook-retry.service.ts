import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { webhookLogs } from '@truvo/db';
import { and, eq, lt, lte } from 'drizzle-orm';
import {
  BACKOFF_MINUTES,
  MAX_RETRY_ATTEMPTS,
  TOPIC_EVENTS,
  WEBHOOKS_DB,
} from '../constants';
import { KafkaProducerService } from '../kafka-producer.service';
import type { Database } from '../webhooks.providers';

const SCAN_INTERVAL_MS = Number(process.env.WEBHOOK_RETRY_SCAN_MS ?? 30_000);
const BATCH_SIZE = 50;

/**
 * Worker de retry (PRD §7 M4: 3 tentativas, backoff 1/5/15 min).
 *
 * Varre `webhook_logs` com status `retrying` e `next_retry_at` vencido, re-publica
 * o evento normalizado (`retry_payload`) no Kafka e atualiza o backoff. Após
 * esgotar as tentativas, marca `failed`.
 *
 * // TODO(live): em produção, preferir um agendador durável (Kafka delay topic,
 * BullMQ/Redis, ou cron) a um setInterval in-process — este é o esqueleto
 * funcional para o MVP. Com múltiplas réplicas da API, mover para um worker
 * dedicado (apps/consumer) para evitar processamento duplicado.
 */
@Injectable()
export class WebhookRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRetryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(WEBHOOKS_DB) private readonly db: Database,
    private readonly kafka: KafkaProducerService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, SCAN_INTERVAL_MS);
    // não segurar o event loop / process exit por causa do timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Uma varredura de retries vencidos. Reentrância protegida por `running`. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.db
        .select()
        .from(webhookLogs)
        .where(
          and(
            eq(webhookLogs.status, 'retrying'),
            lte(webhookLogs.nextRetryAt, new Date()),
            lt(webhookLogs.attempts, MAX_RETRY_ATTEMPTS + 1),
          ),
        )
        .limit(BATCH_SIZE);

      for (const row of due) {
        await this.retryOne(row);
      }
    } catch (err) {
      this.logger.error(`falha na varredura de retry: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async retryOne(row: typeof webhookLogs.$inferSelect): Promise<void> {
    const payload = row.retryPayload;
    if (!payload) {
      await this.db
        .update(webhookLogs)
        .set({ status: 'failed', error: 'retry_payload ausente' })
        .where(eq(webhookLogs.id, row.id));
      return;
    }

    const key = row.workspaceId ?? row.id;
    try {
      await this.kafka.publish(TOPIC_EVENTS, key, payload);
      await this.db
        .update(webhookLogs)
        .set({
          status: 'processed',
          httpStatus: 200,
          nextRetryAt: null,
          error: null,
          attempts: row.attempts + 1,
        })
        .where(eq(webhookLogs.id, row.id));
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      // índice do próximo backoff = nextAttempts - 1 (attempts inclui a inicial).
      const backoffIdx = nextAttempts - 1;
      if (backoffIdx < BACKOFF_MINUTES.length) {
        const waitMin = BACKOFF_MINUTES[backoffIdx]!;
        await this.db
          .update(webhookLogs)
          .set({
            attempts: nextAttempts,
            nextRetryAt: new Date(Date.now() + waitMin * 60_000),
            error: `retry falhou: ${String((err as Error)?.message ?? err)}`,
          })
          .where(eq(webhookLogs.id, row.id));
      } else {
        // esgotou 3 tentativas de retry → falha definitiva.
        await this.db
          .update(webhookLogs)
          .set({
            status: 'failed',
            attempts: nextAttempts,
            nextRetryAt: null,
            error: `retry esgotado: ${String((err as Error)?.message ?? err)}`,
          })
          .where(eq(webhookLogs.id, row.id));
        this.logger.warn(`webhook_log ${row.id} falhou após ${nextAttempts} tentativas`);
      }
    }
  }
}
