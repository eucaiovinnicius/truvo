import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { connectorSyncCheckpoints, connectorSyncRuns, type ConnectorSyncRunKind, type ConnectorSyncRunRow } from '@truvo/db';
import { classifyFailure, metrics, structuredLog } from '@truvo/observability';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { ConnectorConnectionService } from './connector-connection.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { CanonicalMappingService } from './canonical-mapping';
import { readOutcomeMappings } from './crm/crm-write.service';
import type { SourcePullResult, SyncCheckpoint } from './contracts';

const MAX_ATTEMPTS = Number(process.env.CONNECTOR_SYNC_MAX_ATTEMPTS ?? 5);
const BASE_BACKOFF_MS = Number(process.env.CONNECTOR_SYNC_BASE_BACKOFF_MS ?? 30_000);
const MAX_BACKOFF_MS = Number(process.env.CONNECTOR_SYNC_MAX_BACKOFF_MS ?? 15 * 60_000);

export interface SyncRunResult {
  runId: string;
  status: ConnectorSyncRunRow['status'];
  recordsRead: number;
  recordsWritten: number;
  nextCursor: string | null;
  hasMore: boolean;
  /** true when this call returned a PREVIOUSLY-succeeded run without re-invoking the adapter. */
  replayedFromCache: boolean;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/** Exponential backoff + jitter, capped — `retryAfterMs` (from `classifyFailure`,
 * e.g. an HTTP 429/503) always wins when present since the provider told us exactly
 * how long to wait. */
function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs;
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.random() * base * 0.2;
}

/**
 * Order 050 §"Sync orchestration" — durable, workspace/connection-scoped backfill
 * and incremental sync. One `connector_sync_runs` row per (streamKey, checkpoint
 * boundary): a deterministic `idempotencyKey` makes replaying the same boundary a
 * safe no-op (already-succeeded runs are returned from the DB without calling the
 * adapter again), and re-attempting a failed/rate-limited run reuses the SAME row
 * (attempt count increments, never a duplicate). Checkpoint advances only once a
 * run reaches 'succeeded' — never on a partial/failed page.
 */
@Injectable()
export class ConnectorSyncOrchestratorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly connections: ConnectorConnectionService,
    private readonly registry: ConnectorRegistryService,
    private readonly mapping: CanonicalMappingService,
  ) {}

  async runBackfill(workspaceId: string, connectionId: string, streamKey = 'default'): Promise<SyncRunResult> {
    return this.runSync(workspaceId, connectionId, streamKey, 'backfill');
  }

  async runIncremental(workspaceId: string, connectionId: string, streamKey = 'default'): Promise<SyncRunResult> {
    return this.runSync(workspaceId, connectionId, streamKey, 'incremental');
  }

  private async getOrCreateCheckpoint(workspaceId: string, connectionId: string, streamKey: string): Promise<SyncCheckpoint> {
    const [existing] = await this.db
      .select()
      .from(connectorSyncCheckpoints)
      .where(
        and(
          eq(connectorSyncCheckpoints.workspaceId, workspaceId),
          eq(connectorSyncCheckpoints.connectionId, connectionId),
          eq(connectorSyncCheckpoints.streamKey, streamKey),
        ),
      )
      .limit(1);
    if (existing) return { streamKey, cursor: existing.cursor, status: existing.status, processedCount: existing.processedCount };

    await this.db
      .insert(connectorSyncCheckpoints)
      .values({ workspaceId, connectionId, streamKey, status: 'pending' })
      .onConflictDoNothing();
    return { streamKey, cursor: null, status: 'pending', processedCount: 0 };
  }

  private async runSync(
    workspaceId: string,
    connectionId: string,
    streamKey: string,
    kind: Extract<ConnectorSyncRunKind, 'backfill' | 'incremental'>,
  ): Promise<SyncRunResult> {
    const { connection, credentials } = await this.connections.getConnectionWithCredentials(workspaceId, connectionId);
    // A disconnected connection (explicit disconnect() or a provider-side
    // revocation via `markAuthorizationRevoked`) must never be blindly polled —
    // mirrors how `credentialStatus`/`lifecycleState` already gate other actions
    // in `ConnectorConnectionService` (e.g. `testConnection`'s lifecycle-advance
    // check). Only 'disconnected' is refused here: 'error' (a failed sync) must
    // still be retryable — that is the whole point of the retry/backoff model below.
    if (connection.lifecycleState === 'disconnected') {
      throw new BadRequestException(`connection '${connectionId}' is disconnected — sync refused`);
    }
    const adapter = this.registry.getSourceAdapter(connection.provider);
    if (!adapter) throw new BadRequestException(`provider '${connection.provider}' não tem SourceAdapter registrado`);
    const pull = kind === 'backfill' ? adapter.initialBackfill : adapter.incrementalPull;
    if (!pull) throw new BadRequestException(`adapter '${connection.provider}' não suporta '${kind}'`);

    const checkpoint = await this.getOrCreateCheckpoint(workspaceId, connectionId, streamKey);

    // A completed BACKFILL has nothing left to catch up on — short-circuit from the
    // checkpoint's own status rather than recomputing an idempotencyKey, which by
    // definition no longer matches once the checkpoint has advanced past the run
    // that completed it (each successful page moves the cursor, so a later replay
    // would derive a DIFFERENT key from the CURRENT cursor and — wrongly — call the
    // adapter again). Incremental sync deliberately does NOT short-circuit here:
    // "completed" for it just means "caught up as of the last poll," not "done forever."
    if (kind === 'backfill' && checkpoint.status === 'completed') {
      return { runId: '', status: 'succeeded', recordsRead: 0, recordsWritten: 0, nextCursor: checkpoint.cursor, hasMore: false, replayedFromCache: true };
    }

    const idempotencyKey = deterministicId('run', workspaceId, connectionId, streamKey, kind, checkpoint.cursor ?? 'start');

    const [existingRun] = await this.db
      .select()
      .from(connectorSyncRuns)
      .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.connectionId, connectionId), eq(connectorSyncRuns.idempotencyKey, idempotencyKey)))
      .limit(1);

    if (existingRun && existingRun.status === 'succeeded') {
      return {
        runId: existingRun.id,
        status: 'succeeded',
        recordsRead: existingRun.recordsRead,
        recordsWritten: existingRun.recordsWritten,
        nextCursor: existingRun.checkpointAfter,
        hasMore: checkpoint.status === 'running',
        replayedFromCache: true,
      };
    }
    if (existingRun && existingRun.status === 'failed') {
      return {
        runId: existingRun.id,
        status: 'failed',
        recordsRead: existingRun.recordsRead,
        recordsWritten: existingRun.recordsWritten,
        nextCursor: null,
        hasMore: false,
        replayedFromCache: true,
      };
    }

    const attempt = (existingRun?.attempt ?? 0) + 1;
    const runId = existingRun?.id ?? deterministicId('csr', workspaceId, connectionId, idempotencyKey);
    const now = new Date();

    if (existingRun) {
      await this.db
        .update(connectorSyncRuns)
        .set({ status: 'running', attempt, startedAt: now })
        .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));
    } else {
      await this.db.insert(connectorSyncRuns).values({
        workspaceId,
        id: runId,
        connectionId,
        kind,
        idempotencyKey,
        status: 'running',
        attempt,
        checkpointBefore: checkpoint.cursor,
        startedAt: now,
      });
    }
    await this.db
      .update(connectorSyncCheckpoints)
      .set({ status: 'running', startedAt: sql`coalesce(${connectorSyncCheckpoints.startedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(and(eq(connectorSyncCheckpoints.workspaceId, workspaceId), eq(connectorSyncCheckpoints.connectionId, connectionId), eq(connectorSyncCheckpoints.streamKey, streamKey)));
    await this.connections.applySyncOutcome(workspaceId, connectionId, { state: 'syncing' });

    let pullResult: SourcePullResult;
    try {
      pullResult = await pull.call(adapter, connection, credentials, checkpoint);
    } catch (err) {
      return this.handleFailure(workspaceId, connectionId, streamKey, runId, attempt, err);
    }

    const applied = await this.mapping.apply(workspaceId, connectionId, `connector.${connection.provider}`, pullResult.records, readOutcomeMappings(connection.config));
    const finishedAt = new Date();

    await this.db
      .update(connectorSyncRuns)
      .set({
        status: 'succeeded',
        recordsRead: pullResult.records.length,
        recordsWritten: applied.identifiersAttached + applied.traitsWritten + applied.customersResolved,
        checkpointAfter: pullResult.nextCursor,
        nextRetryAt: null,
        errorKind: null,
        errorReason: null,
        finishedAt,
      })
      .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));

    await this.db
      .update(connectorSyncCheckpoints)
      .set({
        cursor: pullResult.nextCursor,
        status: pullResult.hasMore ? 'running' : 'completed',
        processedCount: checkpoint.processedCount + pullResult.records.length,
        lastError: null,
        completedAt: pullResult.hasMore ? null : finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(eq(connectorSyncCheckpoints.workspaceId, workspaceId), eq(connectorSyncCheckpoints.connectionId, connectionId), eq(connectorSyncCheckpoints.streamKey, streamKey)));

    await this.connections.applySyncOutcome(workspaceId, connectionId, { state: pullResult.hasMore ? 'syncing' : 'healthy' });

    metrics.increment('connector_sync_records_total', { provider: connection.provider, kind });
    metrics.gauge('connector_sync_lag_records', pullResult.records.length);

    return {
      runId,
      status: 'succeeded',
      recordsRead: pullResult.records.length,
      recordsWritten: applied.identifiersAttached + applied.traitsWritten + applied.customersResolved,
      nextCursor: pullResult.nextCursor,
      hasMore: pullResult.hasMore,
      replayedFromCache: false,
    };
  }

  private async handleFailure(
    workspaceId: string,
    connectionId: string,
    streamKey: string,
    runId: string,
    attempt: number,
    err: unknown,
  ): Promise<SyncRunResult> {
    const failure = classifyFailure(err);
    const isRateLimit = failure.reason === 'http_429';
    const exhausted = attempt >= MAX_ATTEMPTS;
    const terminal = failure.kind === 'permanent' || exhausted;
    const finishedAt = new Date();

    const status: ConnectorSyncRunRow['status'] = terminal ? 'failed' : isRateLimit ? 'rate_limited' : 'pending';
    const nextRetryAt = terminal ? null : new Date(finishedAt.getTime() + computeBackoffMs(attempt, failure.retryAfterMs));

    await this.db
      .update(connectorSyncRuns)
      .set({
        status,
        errorKind: failure.kind,
        errorReason: failure.reason,
        nextRetryAt,
        finishedAt: terminal ? finishedAt : null,
      })
      .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));

    if (terminal) {
      await this.db
        .update(connectorSyncCheckpoints)
        .set({ status: 'failed', lastError: failure.reason, updatedAt: finishedAt })
        .where(and(eq(connectorSyncCheckpoints.workspaceId, workspaceId), eq(connectorSyncCheckpoints.connectionId, connectionId), eq(connectorSyncCheckpoints.streamKey, streamKey)));
      await this.connections.applySyncOutcome(workspaceId, connectionId, {
        state: 'error',
        error: failure.reason,
        authFailure: failure.reason.startsWith('http_401') || failure.reason === 'http_403',
      });
    } else {
      await this.connections.applySyncOutcome(workspaceId, connectionId, { state: isRateLimit ? 'degraded' : 'syncing', error: failure.reason });
    }

    metrics.increment('connector_sync_failures_total', { kind: failure.kind, terminal: String(terminal), rate_limited: String(isRateLimit) });
    structuredLog('warn', 'connector_sync_failed', { workspaceId, connectionId, streamKey, attempt, terminal, rateLimited: isRateLimit, reason: failure.reason });

    return {
      runId,
      status,
      recordsRead: 0,
      recordsWritten: 0,
      nextCursor: null,
      hasMore: !terminal,
      replayedFromCache: false,
    };
  }
}
