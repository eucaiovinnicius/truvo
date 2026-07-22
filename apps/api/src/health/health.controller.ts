import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'drizzle-orm';
import { STANDARD_EVENTS } from '@truvo/event-schema';
import { getClickHouse, getDb, getRedis } from '../modules/events/infra';
import { pingKafka } from './kafka.health';

type Check = 'ok' | 'down' | 'unknown';

/** Limita uma checagem para que a readiness nunca dependa de um dep lento/pendurado. */
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  /** Liveness — o processo está de pé. */
  @Get()
  liveness() {
    return { status: 'ok', service: 'truvo-api', ts: new Date().toISOString() };
  }

  /**
   * Readiness — pinga DE VERDADE as dependências de infra (PRD §12).
   * Essenciais (gate do 200): ClickHouse + Postgres. Redis/Kafka são
   * informativos e não derrubam o status (blip não deve tirar a API do LB).
   */
  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, Check> = {
      clickhouse: 'unknown',
      postgres: 'unknown',
      redis: 'unknown',
      kafka: 'unknown',
    };

    const [clickhouse, postgres, redis, kafka] = await Promise.all([
      // ClickHouse (essencial) — client memoizado; não fechar (singleton).
      withTimeout(
        (async (): Promise<Check> => {
          const r = await getClickHouse().ping();
          return r.success ? 'ok' : 'down';
        })().catch((): Check => 'down'),
        2000,
        'down',
      ),
      // Postgres/Supabase (essencial) — SELECT 1 via Drizzle.
      withTimeout(
        (async (): Promise<Check> => {
          await getDb().execute(sql`select 1`);
          return 'ok';
        })().catch((): Check => 'down'),
        2000,
        'down',
      ),
      // Redis (informativo) — PING.
      withTimeout(
        (async (): Promise<Check> => {
          const pong = await getRedis().ping();
          return pong === 'PONG' ? 'ok' : 'down';
        })().catch((): Check => 'down'),
        2000,
        'down',
      ),
      // Kafka/Redpanda (informativo) — probe com timeout próprio.
      pingKafka(2000).catch((): Check => 'down'),
    ]);

    checks.clickhouse = clickhouse;
    checks.postgres = postgres;
    checks.redis = redis;
    checks.kafka = kafka;

    // Só as essenciais decidem o 200/503.
    const ready = checks.clickhouse === 'ok' && checks.postgres === 'ok';
    res.status(ready ? 200 : 503);

    return {
      status: ready ? 'ready' : 'degraded',
      essential: ['clickhouse', 'postgres'],
      checks,
      // prova a fiação com @truvo/event-schema:
      standardEvents: STANDARD_EVENTS.length,
      ts: new Date().toISOString(),
    };
  }
}
