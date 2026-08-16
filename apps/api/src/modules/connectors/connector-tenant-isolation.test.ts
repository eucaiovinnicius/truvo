import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, connectorConnections, connectorSyncRuns, connectorDestinationWrites, customers, customerIdentifiers } from '@truvo/db';
import { AuditService } from '../audit/audit.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { CanonicalMappingService } from './canonical-mapping';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorDestinationService } from './connector-destination.service';
import { FAKE_PROVIDER, createFakeDriver, createFakeProviderState, createFakeDestinationAdapter, createFakeSourceAdapter } from './testing/fake-provider.adapter';

/** Order 050 — tenant isolation negative tests: same provider, same idempotency
 * keys, two workspaces — nothing must leak or collide across them. */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order050_tenant_isolation_test_key_dev_only';

let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.DATABASE_URL;
  if (!url) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(url, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
  return reachable;
}

const STAMP = Date.now();
const WS_A = `test_ws_conn_iso_a_${STAMP}`;
const WS_B = `test_ws_conn_iso_b_${STAMP}`;

test('tenant isolation: connections, checkpoints, sync runs, destination writes never cross workspaces', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const registry = new ConnectorRegistryService();
  const connections = new ConnectorConnectionService(db, audit, registry);
  const mapping = new CanonicalMappingService(identityGraph, customerContext);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);

  const state = createFakeProviderState();
  const driver = createFakeDriver(state);
  registry.registerSource(createFakeSourceAdapter(state));
  registry.registerDestination(createFakeDestinationAdapter(state));

  try {
    const connA = await connections.create(WS_A, { provider: FAKE_PROVIDER, role: 'bidirectional', displayName: 'iso-a' });
    const connB = await connections.create(WS_B, { provider: FAKE_PROVIDER, role: 'bidirectional', displayName: 'iso-b' });
    await connections.setCredentials(WS_A, connA.id, driver.validCredentials());
    await connections.setCredentials(WS_B, connB.id, driver.validCredentials());

    // list() never leaks the other workspace's connection.
    const listA = await connections.list(WS_A);
    assert.ok(listA.every((c) => c.workspaceId === WS_A));
    assert.ok(!listA.some((c) => c.id === connB.id));

    // get() under the WRONG workspace must 404, never resolve the other tenant's row.
    await assert.rejects(() => connections.get(WS_A, connB.id));

    // SAME idempotencyKey for backfill on both connections — must not collide (unique index is workspace-scoped).
    driver.seedCatalog([{ identifiers: [{ providerNamespace: FAKE_PROVIDER, identifierType: 'external_id', identifierValue: `iso_${STAMP}` }], observedAt: new Date().toISOString() }]);
    const stream = `iso_stream_${STAMP}`;
    const runA = await orchestrator.runBackfill(WS_A, connA.id, stream);
    const runB = await orchestrator.runBackfill(WS_B, connB.id, stream);
    assert.equal(runA.status, 'succeeded');
    assert.equal(runB.status, 'succeeded');
    assert.notEqual(runA.runId, runB.runId, 'mesma stream/kind/cursor em workspaces diferentes deve gerar runs DIFERENTES');

    const runsA = await db.select().from(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS_A));
    assert.ok(runsA.every((r) => r.workspaceId === WS_A));

    // SAME idempotencyKey for a destination write on both connections.
    const idempotencyKey = `iso_write_${STAMP}`;
    const writeA = await destination.write(WS_A, connA.id, { idempotencyKey, correlationId: 'corr_a', kind: 'profile_upsert', payload: {} });
    const writeB = await destination.write(WS_B, connB.id, { idempotencyKey, correlationId: 'corr_b', kind: 'profile_upsert', payload: {} });
    assert.equal(writeA.status, 'sent');
    assert.equal(writeB.status, 'sent');
    assert.notEqual(writeA.externalResultId, writeB.externalResultId, 'mesma idempotencyKey em workspaces diferentes NÃO deve ser tratada como duplicata cruzada');

    const writesA = await db.select().from(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, WS_A));
    assert.equal(writesA.length, 1);
    assert.ok(writesA.every((w) => w.workspaceId === WS_A));

    // canonical customers created for A never appear under B, even with identical raw values elsewhere isolated by IdentityGraphService's own workspace scoping (Order 045).
    const customersA = await db.select().from(customers).where(eq(customers.workspaceId, WS_A));
    const customersB = await db.select().from(customers).where(eq(customers.workspaceId, WS_B));
    assert.ok(customersA.every((c) => c.workspaceId === WS_A));
    assert.ok(customersB.every((c) => c.workspaceId === WS_B));
    assert.ok(!customersA.some((c) => customersB.some((cb) => cb.id === c.id)));
  } finally {
    for (const ws of [WS_A, WS_B]) {
      await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    await closeDb(db).catch(() => undefined);
  }
});
