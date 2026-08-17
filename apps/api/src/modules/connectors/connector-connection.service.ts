import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { connectorConnections, type ConnectorConnectionRow, type ConnectorCredentialStatus, type ConnectorLifecycleState, type ConnectorRole } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { decryptJson, encryptJson } from './crypto';
import type { ConnectionTestResult, ConnectorConnection } from './contracts';

export interface ConnectorActor {
  id?: string;
  email?: string;
}

export interface CreateConnectionInput {
  provider: string;
  role: ConnectorRole;
  displayName: string;
  config?: Record<string, unknown>;
  capabilities?: string[];
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/**
 * Order 050 — connection CRUD + lifecycle + credential handling, mirroring
 * `webhooks/integrations.service.ts`'s shape (create/list/get/update/remove/test)
 * but for the provider-neutral `connector_connections` table. Reuses `AuditService`
 * with the SAME `category: 'connector'` / `connector.created|updated|deleted`
 * actions the codebase already established (see `integrations.service.ts` and
 * `integrations-out/config.service.ts`), adding only the new credential-specific
 * actions this framework introduces.
 *
 * Enforces the separation the order requires: `testConnection` is the ONLY method
 * that writes `credentialStatus`; every sync-outcome method
 * (`applySyncOutcome`) is the ONLY thing that writes `lifecycleState` from sync
 * results, and it NEVER touches `credentialStatus` unless the adapter explicitly
 * reports `authFailure: true`.
 */
@Injectable()
export class ConnectorConnectionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly registry: ConnectorRegistryService,
  ) {}

  private sanitize(row: ConnectorConnectionRow): ConnectorConnection {
    const { credentialsEncrypted: _drop, ...rest } = row;
    return rest;
  }

  async create(workspaceId: string, input: CreateConnectionInput, actor?: ConnectorActor): Promise<ConnectorConnection> {
    if (!this.registry.getDefinition(input.provider)) {
      throw new BadRequestException(`provider '${input.provider}' não está registrado no ConnectorRegistryService`);
    }
    const id = deterministicId('conn', workspaceId, input.provider, input.displayName, Date.now().toString());
    const [row] = await this.db
      .insert(connectorConnections)
      .values({
        workspaceId,
        id,
        provider: input.provider,
        role: input.role,
        displayName: input.displayName,
        config: input.config ?? {},
        capabilities: input.capabilities ?? [],
      })
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.created',
      resourceType: 'connector_connection',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
      metadata: { provider: input.provider, role: input.role },
    });

    return this.sanitize(row!);
  }

  async list(workspaceId: string): Promise<ConnectorConnection[]> {
    const rows = await this.db.select().from(connectorConnections).where(eq(connectorConnections.workspaceId, workspaceId));
    return rows.map((r) => this.sanitize(r));
  }

  private async findOwnedRaw(workspaceId: string, id: string): Promise<ConnectorConnectionRow> {
    const [row] = await this.db
      .select()
      .from(connectorConnections)
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('conexão de conector não encontrada');
    return row;
  }

  async get(workspaceId: string, id: string): Promise<ConnectorConnection> {
    return this.sanitize(await this.findOwnedRaw(workspaceId, id));
  }

  /** Internal use only (orchestrator/webhook/destination services) — decrypted
   * credentials never leave this service through any other method. */
  async getConnectionWithCredentials(
    workspaceId: string,
    id: string,
  ): Promise<{ connection: ConnectorConnection; credentials: Record<string, unknown> }> {
    const row = await this.findOwnedRaw(workspaceId, id);
    const credentials = row.credentialsEncrypted ? decryptJson(row.credentialsEncrypted) : {};
    return { connection: this.sanitize(row), credentials };
  }

  /** Stores/rotates credentials — auditable, never logs the secret itself. Moves a
   * fresh connection from 'draft' to 'authorizing' (credentials submitted, not yet
   * proven) — `testConnection` is what proves them. */
  async setCredentials(
    workspaceId: string,
    id: string,
    credentials: Record<string, unknown>,
    actor?: ConnectorActor,
  ): Promise<ConnectorConnection> {
    const existing = await this.findOwnedRaw(workspaceId, id);
    const nextLifecycle: ConnectorLifecycleState = existing.lifecycleState === 'draft' ? 'authorizing' : existing.lifecycleState;

    const [row] = await this.db
      .update(connectorConnections)
      .set({ credentialsEncrypted: encryptJson(credentials), lifecycleState: nextLifecycle, updatedAt: new Date() })
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)))
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.credential_rotated',
      resourceType: 'connector_connection',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
      metadata: { provider: existing.provider },
    });

    return this.sanitize(row!);
  }

  /**
   * Order 061 §1 — "portal/account identity stored as immutable connection
   * metadata." Merges into the EXISTING `config` (never replaces wholesale) so
   * this can be called independently of object/property-selection or outcome-
   * mapping config (Order 061 §2/§5) already stored there — one connection, one
   * config bag, every writer only ever adds/overwrites its own keys.
   */
  async updateConfig(workspaceId: string, id: string, patch: Record<string, unknown>): Promise<ConnectorConnection> {
    const existing = await this.findOwnedRaw(workspaceId, id);
    // A provider account/portal/shop identity is an authorization result, never a
    // user-editable preference. Refuse a later callback/config patch that would
    // silently retarget an existing connection to another represented account.
    for (const key of ['stripe_account_id', 'hubspot_portal_id', 'shop_domain']) {
      const previous = (existing.config as Record<string, unknown>)[key];
      if (previous !== undefined && patch[key] !== undefined && patch[key] !== previous) {
        throw new BadRequestException(`immutable connection metadata '${key}' cannot be changed`);
      }
    }
    const [row] = await this.db
      .update(connectorConnections)
      .set({ config: { ...(existing.config as Record<string, unknown>), ...patch }, updatedAt: new Date() })
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)))
      .returning();
    return this.sanitize(row!);
  }

  /**
   * The ONLY method that writes `credentialStatus`. On success, advances
   * `lifecycleState` to 'connected' — but only from states where that's a genuine
   * forward step (draft/authorizing/error); an already-syncing/healthy connection
   * being re-tested keeps its richer state instead of being reset backward.
   */
  async testConnection(workspaceId: string, id: string, actor?: ConnectorActor): Promise<ConnectionTestResult> {
    const { connection, credentials } = await this.getConnectionWithCredentials(workspaceId, id);
    const source = this.registry.getSourceAdapter(connection.provider);
    const destination = this.registry.getDestinationAdapter(connection.provider);
    const adapter = source ?? destination;
    if (!adapter) throw new BadRequestException(`provider '${connection.provider}' não tem adapter registrado`);

    const result = await adapter.testConnection(connection, credentials);
    const credentialStatus: ConnectorCredentialStatus = result.credentialStatus;
    const lifecycleAdvanceFrom: ConnectorLifecycleState[] = ['draft', 'authorizing', 'error'];
    const nextLifecycle: ConnectorLifecycleState =
      result.ok && lifecycleAdvanceFrom.includes(connection.lifecycleState) ? 'connected' : connection.lifecycleState;

    await this.db
      .update(connectorConnections)
      .set({
        credentialStatus,
        lifecycleState: nextLifecycle,
        lastCredentialCheckAt: new Date(),
        lastError: result.ok ? null : result.message,
        updatedAt: new Date(),
      })
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)));

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.credential_tested',
      resourceType: 'connector_connection',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
      metadata: { provider: connection.provider, ok: result.ok, credential_status: credentialStatus },
    });

    return result;
  }

  /**
   * Sync-outcome-driven lifecycle transition — the ONLY writer of `lifecycleState`
   * from sync results. Never touches `credentialStatus` (a failed sync must not
   * invalidate otherwise-valid credentials) UNLESS `authFailure` is explicitly set,
   * which is a genuine credential problem, not merely "a sync failed."
   */
  async applySyncOutcome(
    workspaceId: string,
    id: string,
    outcome: { state: ConnectorLifecycleState; error?: string | null; authFailure?: boolean },
  ): Promise<void> {
    const patch: Partial<typeof connectorConnections.$inferInsert> = {
      lifecycleState: outcome.state,
      lastError: outcome.error ?? null,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    };
    if (outcome.authFailure) patch.credentialStatus = 'invalid';

    await this.db
      .update(connectorConnections)
      .set(patch)
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)));
  }

  async disconnect(workspaceId: string, id: string, actor?: ConnectorActor): Promise<ConnectorConnection> {
    const existing = await this.findOwnedRaw(workspaceId, id);
    const adapter = this.registry.getSourceAdapter(existing.provider);
    if (adapter?.deauthorize && existing.credentialsEncrypted) {
      await adapter.deauthorize(this.sanitize(existing), decryptJson(existing.credentialsEncrypted));
    }
    const [row] = await this.db
      .update(connectorConnections)
      .set({ lifecycleState: 'disconnected', updatedAt: new Date() })
      .where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)))
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.disconnected',
      resourceType: 'connector_connection',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
    });

    return this.sanitize(row!);
  }

  /** Provider revocation is a credential fact, not a generic sync-health issue. */
  async markAuthorizationRevoked(workspaceId: string, id: string): Promise<void> {
    await this.db.update(connectorConnections).set({ credentialStatus: 'invalid', lifecycleState: 'disconnected', lastError: 'provider authorization revoked', updatedAt: new Date() }).where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)));
  }

  async remove(workspaceId: string, id: string, actor?: ConnectorActor): Promise<void> {
    const existing = await this.findOwnedRaw(workspaceId, id);
    await this.db.delete(connectorConnections).where(and(eq(connectorConnections.workspaceId, workspaceId), eq(connectorConnections.id, id)));

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.deleted',
      resourceType: 'connector_connection',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
      metadata: { provider: existing.provider },
    });
  }
}
