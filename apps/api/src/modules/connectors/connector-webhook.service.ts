import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { connectorSyncRuns } from '@truvo/db';
import { classifyFailure, metrics, structuredLog } from '@truvo/observability';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { ConnectorConnectionService } from './connector-connection.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { CanonicalMappingService } from './canonical-mapping';
import { readOutcomeMappings } from './crm/crm-write.service';
import type { RawWebhookRequest } from './contracts';

export interface ConnectorWebhookResult {
  status: 'ok' | 'ignored' | 'rejected' | 'duplicate' | 'failed';
  reason?: string;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/**
 * Order 050 §"Webhooks" — provider-specific verification BEFORE normalization
 * (mirrors `webhooks.service.ts#handleIncoming`'s exact ordering: verify → durable
 * job → normalize/apply), invalid signatures fail closed and observable, duplicate
 * delivery is harmless. Reuses `connector_sync_runs` (kind='webhook_ingest') as the
 * durable/idempotent job ledger — the SAME unique-index mechanism that makes
 * backfill/incremental retries idempotent also makes redelivery idempotent here, no
 * separate table needed.
 */
@Injectable()
export class ConnectorWebhookService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly connections: ConnectorConnectionService,
    private readonly registry: ConnectorRegistryService,
    private readonly mapping: CanonicalMappingService,
  ) {}

  async handleWebhook(workspaceId: string, connectionId: string, request: RawWebhookRequest): Promise<ConnectorWebhookResult> {
    const { connection, credentials } = await this.connections.getConnectionWithCredentials(workspaceId, connectionId);
    const adapter = this.registry.getSourceAdapter(connection.provider);
    if (!adapter?.verifyWebhook) throw new BadRequestException(`provider '${connection.provider}' não suporta webhook_ingest`);

    // 1. verify BEFORE any processing — fail closed, observable.
    const valid = adapter.verifyWebhook(connection, credentials, request);
    if (!valid) {
      metrics.increment('connector_webhook_verification_failures_total', { provider: connection.provider });
      structuredLog('warn', 'connector_webhook_invalid_signature', { workspaceId, connectionId, provider: connection.provider });
      return { status: 'rejected', reason: 'invalid_signature' };
    }

    // 2. durable + idempotent job. deliveryId absent → derive one from the body (best-effort).
    const deliveryId = request.deliveryId ?? deterministicId('whd', JSON.stringify(request.body ?? {}));
    const runId = deterministicId('csr', workspaceId, connectionId, 'webhook_ingest', deliveryId);
    const [inserted] = await this.db
      .insert(connectorSyncRuns)
      .values({ workspaceId, id: runId, connectionId, kind: 'webhook_ingest', idempotencyKey: deliveryId, status: 'running', attempt: 1, startedAt: new Date() })
      .onConflictDoNothing({ target: [connectorSyncRuns.workspaceId, connectorSyncRuns.connectionId, connectorSyncRuns.idempotencyKey] })
      .returning();
    if (!inserted) {
      return { status: 'duplicate', reason: 'already_processed' };
    }

    // 3. normalize → canonical mapping (no adapter-side identity matching).
    const records = adapter.normalizeWebhook?.(connection, request) ?? null;
    if (!records) {
      await this.db.update(connectorSyncRuns).set({ status: 'succeeded', finishedAt: new Date() }).where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));
      return { status: 'ignored' };
    }

    try {
      const applied = await this.mapping.apply(workspaceId, connectionId, `connector.${connection.provider}`, records, readOutcomeMappings(connection.config));
      await this.db
        .update(connectorSyncRuns)
        .set({
          status: 'succeeded',
          recordsRead: records.length,
          recordsWritten: applied.identifiersAttached + applied.traitsWritten + applied.customersResolved,
          finishedAt: new Date(),
        })
        .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));
      return { status: 'ok' };
    } catch (err) {
      const failure = classifyFailure(err);
      await this.db
        .update(connectorSyncRuns)
        .set({ status: 'failed', errorKind: failure.kind, errorReason: failure.reason, finishedAt: new Date() })
        .where(and(eq(connectorSyncRuns.workspaceId, workspaceId), eq(connectorSyncRuns.id, runId)));
      structuredLog('error', 'connector_webhook_apply_failed', { workspaceId, connectionId, provider: connection.provider, reason: failure.reason });
      return { status: 'failed', reason: failure.reason };
    }
  }
}
