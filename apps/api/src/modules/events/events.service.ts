import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import type { TruvoEvent } from '@truvo/event-schema';
import { KafkaProducerService } from './kafka.producer';
import { getClickHouse } from './infra';
import type { ApiIngestDto, ApiBatchDto } from './dto/ingest.dto';

/** Formata um Date como DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
function toChDateTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
}

@Injectable()
export class EventsService {
  constructor(private readonly kafka: KafkaProducerService) {}

  /**
   * Normaliza um payload de ingestão em um TruvoEvent completo:
   * - `event_id` gerado (ulid) se ausente — idempotência (o cliente pode fornecer);
   * - `workspace_id` SEMPRE sobrescrito pelo do API key (regra 1) — nunca confia no corpo;
   * - `received_at` = agora; `timestamp` = fornecido ou = received_at (PRD §7 enrich).
   */
  private normalize(input: ApiIngestDto, workspaceId: string): TruvoEvent {
    const receivedAt = new Date().toISOString();
    return {
      ...input,
      event_id: input.event_id ?? `evt_${ulid()}`,
      workspace_id: workspaceId,
      received_at: input.received_at ?? receivedAt,
      timestamp: input.timestamp ?? receivedAt,
      properties: input.properties ?? {},
      context: input.context ?? {},
    };
  }

  /** POST /v1/events — publica 1 evento no Kafka e retorna imediatamente (regra 9). */
  async ingestOne(input: ApiIngestDto, workspaceId: string) {
    const event = this.normalize(input, workspaceId);
    await this.kafka.publish([{ key: workspaceId, value: JSON.stringify(event) }]);
    return { accepted: 1, event_id: event.event_id };
  }

  /** POST /v1/events/batch — publica N eventos (1..500) num único send. */
  async ingestBatch(inputs: ApiBatchDto, workspaceId: string) {
    const events = inputs.map((i) => this.normalize(i, workspaceId));
    await this.kafka.publish(
      events.map((e) => ({ key: workspaceId, value: JSON.stringify(e) })),
    );
    return { accepted: events.length, event_ids: events.map((e) => e.event_id) };
  }

  /** GET /v1/events/recent — últimos 50 eventos do workspace (debug view). */
  async recent(workspaceId: string) {
    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          event_id, event_name, source, workspace_id,
          timestamp, received_at,
          anonymous_id, user_id, session_id, order_id,
          utm_source, utm_medium, utm_campaign,
          ip_country, ip_city, device_type, os, browser,
          value, currency, is_bot
        FROM events
        WHERE workspace_id = {workspace_id:String}
        ORDER BY received_at DESC
        LIMIT 50`,
      query_params: { workspace_id: workspaceId },
      format: 'JSONEachRow',
    });
    return { events: await rs.json() };
  }

  /**
   * GET /v1/events/volume — série temporal por hora/dia. Reporta total, humanos e
   * bots separadamente (bots existem na tabela raw mas nunca contam p/ métrica — regra 11).
   */
  async volume(workspaceId: string, granularity: 'hour' | 'day', startIso?: string, endIso?: string) {
    const end = endIso ? new Date(endIso) : new Date();
    const defaultSpanMs = granularity === 'hour' ? 24 * 3600_000 : 30 * 24 * 3600_000;
    const start = startIso ? new Date(startIso) : new Date(end.getTime() - defaultSpanMs);

    // granularity é validado por enum (zod) — seguro interpolar; valores são params.
    const bucket = granularity === 'hour' ? 'toStartOfHour(timestamp)' : 'toStartOfDay(timestamp)';

    const ch = getClickHouse();
    const rs = await ch.query({
      query: `
        SELECT
          ${bucket} AS bucket,
          count()               AS total,
          countIf(is_bot = 0)   AS humans,
          countIf(is_bot = 1)   AS bots,
          sumIf(value, is_bot = 0) AS revenue
        FROM events
        WHERE workspace_id = {workspace_id:String}
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
        GROUP BY bucket
        ORDER BY bucket`,
      query_params: {
        workspace_id: workspaceId,
        start: toChDateTime(start.toISOString()),
        end: toChDateTime(end.toISOString()),
      },
      format: 'JSONEachRow',
    });
    return {
      granularity,
      start: start.toISOString(),
      end: end.toISOString(),
      series: await rs.json(),
    };
  }
}
