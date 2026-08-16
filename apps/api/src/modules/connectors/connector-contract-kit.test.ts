import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  connectorConnections,
  connectorSyncCheckpoints,
  connectorSyncRuns,
  connectorDestinationWrites,
  customers,
  customerIdentifiers,
} from '@truvo/db';
import { AuditService } from '../audit/audit.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { CanonicalMappingService } from './canonical-mapping';
import { CommerceWriteService } from './commerce/commerce-write.service';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorDestinationService } from './connector-destination.service';
import { ConnectorWebhookService } from './connector-webhook.service';
import { FAKE_PROVIDER, createFakeDriver, createFakeProviderState, createFakeDestinationAdapter, createFakeSourceAdapter } from './testing/fake-provider.adapter';
import type { ConnectorContractHarness } from './testing/connector-contract-kit';
import {
  proveBackfillCheckpointResume,
  proveConnectionLifecycle,
  proveCredentialFailureSeparateFromSyncHealth,
  proveDefinitionCapabilities,
  proveDestinationIdempotencyAndCorrelation,
  proveDuplicateWebhookIsHarmless,
  proveInvalidWebhookSignatureRejected,
  provePermanentErrorStops,
  proveRateLimitReschedules,
  proveTransientRetryThenSuccess,
} from './testing/connector-contract-kit';

/**
 * Order 050 §"Contract test kit" — runs the reusable proof suite (§"Contract test
 * kit" acceptance items) against the fake provider adapter, against a REAL
 * Postgres. Same skip-if-unreachable pattern as every prior order's real-DB test.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order050_contract_kit_test_key_dev_only';

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
const WS = `test_ws_connectors_${STAMP}`;

test('Connector Framework contract kit: fake provider proves the framework end-to-end', async (t) => {
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
  const mapping = new CanonicalMappingService(identityGraph, customerContext, new CommerceWriteService(db, customerContext));
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const state = createFakeProviderState();
  const driver = createFakeDriver(state);
  registry.registerSource(createFakeSourceAdapter(state));
  registry.registerDestination(createFakeDestinationAdapter(state));

  const harness: ConnectorContractHarness = { workspaceId: WS, provider: FAKE_PROVIDER, registry, connections, orchestrator, destination, webhook };

  try {
    await t.test('definition declares capabilities independently (source/destination/bidirectional)', () => proveDefinitionCapabilities(harness));
    await t.test('connection lifecycle: draft → authorizing → connected → disconnected', () => proveConnectionLifecycle(harness, driver));
    await t.test('credential failure is separate from sync health', () => proveCredentialFailureSeparateFromSyncHealth(harness, driver));
    await t.test('initial backfill + durable checkpoint resume', () => proveBackfillCheckpointResume(harness, driver));
    await t.test('transient failure retries then succeeds', () => proveTransientRetryThenSuccess(harness, driver));
    await t.test('permanent error stops (terminal, no infinite retry, auth failure flags credentials)', () => provePermanentErrorStops(harness, driver));
    await t.test('rate limit reschedules without dropping records', () => proveRateLimitReschedules(harness, driver));
    await t.test('duplicate webhook delivery is harmless', () => proveDuplicateWebhookIsHarmless(harness, driver));
    await t.test('invalid webhook signature fails closed', () => proveInvalidWebhookSignatureRejected(harness, driver));
    await t.test('destination write idempotency + correlation + external result id', () => proveDestinationIdempotencyAndCorrelation(harness, driver));

    // canonical mapping proof: the backfill/webhook proofs above already exercised
    // IdentityGraphService/CustomerContextService end-to-end — confirm real rows exist.
    await t.test('canonical mapping actually wrote through Identity Graph v2 / Customer Context (no adapter-local identity)', async () => {
      const rows = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS));
      const fakeProviderRows = rows.filter((r) => r.providerNamespace === FAKE_PROVIDER);
      assert.ok(fakeProviderRows.length > 0, 'a projeção deve ter criado identifiers reais via IdentityGraphService');
    });
  } finally {
    await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS)).catch(() => undefined);
    await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
