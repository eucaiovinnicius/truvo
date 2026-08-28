import type Redis from 'ioredis';
import { createClickHouse, type ClickHouseClient } from '@truvo/db';
import { getRedis } from '../redis';
import {
  ackEntry,
  ensureConsumerGroup,
  readNewEntries,
  reclaimStale,
  type StitchEntry,
} from './stitch-queue';
import { runRetroStitch } from './retro-stitch';
import { structuredLog } from '@truvo/observability';

const CONSUMER_NAME =
  process.env.IDENTITY_STITCH_CONSUMER ?? `stitch-${process.env.HOSTNAME ?? 'local'}-${process.pid}`;
const BATCH_COUNT = Number(process.env.IDENTITY_STITCH_BATCH ?? 16);
const BLOCK_MS = Number(process.env.IDENTITY_STITCH_BLOCK_MS ?? 5000);
const RECLAIM_IDLE_MS = Number(process.env.IDENTITY_STITCH_RECLAIM_IDLE_MS ?? 60_000);

/**
 * Worker do stitching RETROATIVO (M8). Consome o Redis stream `identity.stitch`
 * (consumer group + checkpoints por XACK) e aplica `runRetroStitch` por entrada.
 *
 * Garantias:
 *   · at-least-once → uma entrada só é ACKada após o recompute concluir;
 *   · reprocessável → falha deixa a entrada PENDING; XAUTOCLAIM reivindica jobs de
 *     workers que caíram (ociosos > RECLAIM_IDLE_MS) e reprocessa (recompute é idempotente);
 *   · malformadas → ACKadas p/ não travar o group (TODO(live): dead-letter stream).
 */
export class StitchWorker {
  private readonly ch: ClickHouseClient = createClickHouse();
  private running = false;

  async start(): Promise<void> {
    const redis = getRedis();
    await ensureConsumerGroup(redis);
    this.running = true;
    structuredLog('info', 'identity_stitch_worker_ready', { consumer: CONSUMER_NAME });

    while (this.running) {
      try {
        // Primeiro reivindica pendências ociosas (jobs órfãos de crashes anteriores)...
        const reclaimed = await reclaimStale(redis, CONSUMER_NAME, RECLAIM_IDLE_MS, BATCH_COUNT);
        await this.process(redis, reclaimed.entries, reclaimed.malformed);

        // ...depois lê novas entradas, bloqueando até BLOCK_MS.
        const fresh = await readNewEntries(redis, CONSUMER_NAME, BATCH_COUNT, BLOCK_MS);
        await this.process(redis, fresh.entries, fresh.malformed);
      } catch (err) {
        // TODO(live): backoff/alerta. Não derruba o loop por blip de Redis/ClickHouse.
        structuredLog('error', 'identity_stitch_loop_failed', { errorType: (err as Error).name, retryAfterMs: 1000 });
        await sleep(1000);
      }
    }
  }

  private async process(redis: Redis, entries: StitchEntry[], malformed: string[]): Promise<void> {
    for (const id of malformed) {
      structuredLog('warn', 'identity_stitch_entry_malformed', { entryId: id, disposition: 'ack' });
      await ackEntry(redis, id);
    }

    for (const { id, job } of entries) {
      try {
        const res = await runRetroStitch(this.ch, job);
        await ackEntry(redis, id);
        structuredLog('info', 'identity_stitch_completed', { workspaceId: res.workspace_id, canonicalId: res.canonical_id, mergedCount: res.losers });
      } catch (err) {
        // NÃO ACKa: a entrada fica PENDING e será reivindicada/reprocessada.
        // TODO(live): após N tentativas (XPENDING delivery count), mover p/ dead-letter.
        structuredLog('error', 'identity_stitch_failed', { workspaceId: job.workspace_id, canonicalId: job.canonical_id, errorType: (err as Error).name, disposition: 'requeue' });
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.ch.close().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
