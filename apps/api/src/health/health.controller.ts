import { Controller, Get } from '@nestjs/common';
import { createClickHouse } from '@truvo/db';
import { STANDARD_EVENTS } from '@truvo/event-schema';

@Controller('health')
export class HealthController {
  /** Liveness — o processo está de pé. */
  @Get()
  liveness() {
    return { status: 'ok', service: 'truvo-api', ts: new Date().toISOString() };
  }

  /** Readiness — dependências de infra respondem (PRD §12). */
  @Get('ready')
  async readiness() {
    const checks: Record<string, string> = {};

    // ClickHouse (Docker local)
    try {
      const ch = createClickHouse();
      const res = await ch.ping();
      checks.clickhouse = res.success ? 'ok' : 'down';
      await ch.close();
    } catch {
      checks.clickhouse = 'down';
    }

    // Postgres/Redis/Kafka: conectados de fato nos módulos M1/M2.
    checks.postgres = process.env.DATABASE_URL ? 'configured' : 'not_configured';
    checks.redis = 'pending';
    checks.kafka = 'pending';

    const ready = checks.clickhouse === 'ok';
    return {
      status: ready ? 'ready' : 'degraded',
      checks,
      // prova a fiação com @truvo/event-schema:
      standardEvents: STANDARD_EVENTS.length,
    };
  }
}
