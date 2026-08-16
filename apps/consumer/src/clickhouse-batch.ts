import { createClickHouse, type ClickHouseClient } from '@truvo/db';
import type { TruvoEvent } from '@truvo/event-schema';
import type { EnrichedContext } from './enrich';
import { classifyFailure, metrics, structuredLog } from '@truvo/observability';

/** DateTime64(3) do ClickHouse: 'YYYY-MM-DD HH:MM:SS.mmm' (UTC, sem 'Z'). */
function toChDateTime(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Linha achatada da tabela `events`. Note: SEM coluna de `ip` bruto (regra 5). */
export interface ClickHouseEventRow {
  event_id: string;
  event_name: string;
  source: string;
  workspace_id: string;
  timestamp: string;
  received_at: string;
  anonymous_id: string;
  user_id: string;
  session_id: string;
  click_id: string;
  order_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  page_url: string;
  referrer: string;
  ip_country: string;
  ip_city: string;
  device_type: string;
  os: string;
  browser: string;
  user_agent: string;
  value: number;
  currency: string;
  is_bot: number;
  properties: string;
  context: string;
  raw: string;
}

/** Constrói a linha do ClickHouse a partir do evento + enriquecimento + is_bot. */
export function buildRow(event: TruvoEvent, enriched: EnrichedContext, isBot: boolean): ClickHouseEventRow {
  const ctx = event.context ?? {};
  const props = event.properties ?? {};

  // regra 5: remove o IP bruto do context antes de persistir o JSON original.
  const { ip: _dropIp, ...contextForStorage } = ctx as Record<string, unknown>;

  return {
    event_id: event.event_id,
    event_name: event.event_name,
    source: event.source,
    workspace_id: event.workspace_id,
    timestamp: toChDateTime(event.timestamp ?? event.received_at),
    received_at: toChDateTime(event.received_at),
    anonymous_id: event.anonymous_id ?? '',
    user_id: event.user_id ?? '',
    session_id: event.session_id ?? '',
    click_id: event.click_id ?? '',
    order_id: event.order_id ?? '',
    utm_source: (ctx.utm_source as string) ?? '',
    utm_medium: (ctx.utm_medium as string) ?? '',
    utm_campaign: (ctx.utm_campaign as string) ?? '',
    utm_content: (ctx.utm_content as string) ?? '',
    utm_term: (ctx.utm_term as string) ?? '',
    page_url: (ctx.page_url as string) ?? '',
    referrer: (ctx.referrer as string) ?? '',
    ip_country: enriched.ip_country,
    ip_city: enriched.ip_city,
    device_type: enriched.device_type,
    os: enriched.os,
    browser: enriched.browser,
    user_agent: (ctx.user_agent as string) ?? '',
    value: toNumber(props.value),
    currency: (props.currency as string) ?? '',
    is_bot: isBot ? 1 : 0,
    properties: JSON.stringify(props),
    context: JSON.stringify(contextForStorage),
    raw: JSON.stringify({ ...event, context: contextForStorage }),
  };
}

/**
 * Batcher de inserção no ClickHouse: flush a cada 100 linhas OU 1s (PRD §7 M2, passo 6).
 * Buffer em memória — em caso de crash, as mensagens não commitadas do Kafka são
 * reprocessadas (o dedup por event_id + ReplacingMergeTree garantem idempotência).
 */
export class ClickHouseBatcher {
  private readonly ch: ClickHouseClient = createClickHouse();
  private buffer: ClickHouseEventRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** Fila serializada de flushes — nunca dois inserts concorrentes. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRows = Number(process.env.CH_BATCH_MAX_ROWS ?? 100),
    private readonly maxDelayMs = Number(process.env.CH_BATCH_MAX_DELAY_MS ?? 1000),
  ) {}

  async add(row: ClickHouseEventRow): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxRows) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush().catch(() => undefined);
      }, this.maxDelayMs);
    }
  }

  /**
   * Enfileira um flush. Flushes são serializados (nunca concorrentes): a fila
   * interna sempre resolve p/ manter a cadeia viva, mas o chamador recebe o
   * resultado real — se o insert falhar, a promise rejeita e o eachBatch não
   * commita os offsets (reprocessa; idempotente via dedup + ReplacingMergeTree).
   */
  flush(): Promise<void> {
    const run = this.queue.catch(() => undefined).then(() => this.doFlush());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;

    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.ch.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
      metrics.increment('storage_writes_total', { storage: 'clickhouse', result: 'success' });
      // eslint-disable-next-line no-console
      console.log(`[truvo/consumer] inseridas ${rows.length} linha(s) no ClickHouse`);
    } catch (err) {
      // Recoloca no início do buffer p/ nova tentativa. TODO(live): DLQ/backoff.
      this.buffer = rows.concat(this.buffer);
      const failure = classifyFailure(err);
      metrics.increment('storage_writes_total', { storage: 'clickhouse', result: 'failure' });
      metrics.gauge('consumer_retry_buffer_rows', this.buffer.length);
      structuredLog('error', 'storage_write_failed', { storage: 'clickhouse', retryable: failure.kind === 'transient', retryAfterMs: failure.retryAfterMs, bufferedRows: this.buffer.length });
      // eslint-disable-next-line no-console
      console.error(`[truvo/consumer] falha no insert ClickHouse (requeue): ${(err as Error).message}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.ch.close();
  }
}
