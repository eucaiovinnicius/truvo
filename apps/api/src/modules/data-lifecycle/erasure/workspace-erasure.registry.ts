import { eq } from 'drizzle-orm';
import type { ClickHouseClient } from '@truvo/db';
import { identityLinks, identityMerges, identityConflicts, identityMergeEvents, connectorConnections, integrations, integrationOutConfigs } from '@truvo/db';
import type { Database } from '../../auth/database.provider';

/**
 * Order 055 §4 — WORKSPACE DELETION, extended to the stores that didn't exist when
 * Order 035 shipped `tombstoneWorkspace` (Orders 40/45/50). Workspace deletion is a
 * TERMINAL operation (the whole tenant ceases to exist) — unlike subject deletion,
 * which must preserve audit trail for a workspace that keeps operating, these are
 * HARD deletes, not tombstones: there is no "grace period" concept for a workspace
 * that no longer exists. `connector_connections` cascades to
 * `connector_sync_checkpoints`/`connector_sync_runs`/`connector_destination_writes`
 * (FK `ON DELETE CASCADE`, Order 050) — deleting it is enough for all four.
 * Credentials (`integrations.credentials_encrypted`,
 * `integration_out_configs.credentials_encrypted`,
 * `connector_connections.credentials_encrypted`) are destroyed by the same row
 * deletes — "handled through the existing secure deletion path" per the order.
 */
export interface WorkspaceErasureContext {
  db: Database;
  ch: ClickHouseClient;
  workspaceId: string;
}

export interface StoreErasureResult {
  status: 'completed' | 'failed';
  processedCount: number;
  error?: string;
}

export type WorkspaceErasureHandler = (ctx: WorkspaceErasureContext) => Promise<StoreErasureResult>;

async function ok(processedCount: number): Promise<StoreErasureResult> {
  return { status: 'completed', processedCount };
}

export const eraseWorkspaceIdentityV1: WorkspaceErasureHandler = async (ctx) => {
  const links = await ctx.db.delete(identityLinks).where(eq(identityLinks.workspaceId, ctx.workspaceId)).returning({ id: identityLinks.id });
  const merges = await ctx.db.delete(identityMerges).where(eq(identityMerges.workspaceId, ctx.workspaceId)).returning({ id: identityMerges.id });
  return ok(links.length + merges.length);
};

export const eraseWorkspaceIdentityGraphV2: WorkspaceErasureHandler = async (ctx) => {
  const conflicts = await ctx.db.delete(identityConflicts).where(eq(identityConflicts.workspaceId, ctx.workspaceId)).returning({ id: identityConflicts.id });
  const events = await ctx.db.delete(identityMergeEvents).where(eq(identityMergeEvents.workspaceId, ctx.workspaceId)).returning({ id: identityMergeEvents.id });
  return ok(conflicts.length + events.length);
};

/** Deleting connections cascades to checkpoints/sync runs/destination writes (Order 050 FKs). */
export const eraseWorkspaceConnectors: WorkspaceErasureHandler = async (ctx) => {
  const rows = await ctx.db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ctx.workspaceId)).returning({ id: connectorConnections.id });
  return ok(rows.length);
};

export const eraseWorkspaceIntegrations: WorkspaceErasureHandler = async (ctx) => {
  const inbound = await ctx.db.delete(integrations).where(eq(integrations.workspaceId, ctx.workspaceId)).returning({ id: integrations.id });
  const outbound = await ctx.db.delete(integrationOutConfigs).where(eq(integrationOutConfigs.workspaceId, ctx.workspaceId)).returning({ id: integrationOutConfigs.id });
  return ok(inbound.length + outbound.length);
};

export const eraseWorkspaceClickHouse: WorkspaceErasureHandler = async (ctx) => {
  try {
    await ctx.ch.command({
      query: `ALTER TABLE events DELETE WHERE workspace_id = {ws:String}`,
      query_params: { ws: ctx.workspaceId },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await ctx.ch.command({
      query: `ALTER TABLE touchpoints DELETE WHERE workspace_id = {ws:String}`,
      query_params: { ws: ctx.workspaceId },
      clickhouse_settings: { mutations_sync: '1' },
    });
  } catch (err) {
    return { status: 'failed', processedCount: 0, error: (err as Error).message };
  }
  return ok(1);
};

export const WORKSPACE_ERASURE_EXTRA_STORES: ReadonlyArray<{ store: string; handler: WorkspaceErasureHandler }> = [
  { store: 'identity_v1_ws', handler: eraseWorkspaceIdentityV1 },
  { store: 'identity_graph_v2_ws', handler: eraseWorkspaceIdentityGraphV2 },
  { store: 'connectors_ws', handler: eraseWorkspaceConnectors },
  { store: 'integrations_ws', handler: eraseWorkspaceIntegrations },
  { store: 'clickhouse_ws', handler: eraseWorkspaceClickHouse },
];
