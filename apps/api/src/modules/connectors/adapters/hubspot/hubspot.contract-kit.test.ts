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
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService } from '../../../identity/identity-graph.service';
import { closeRedis } from '../../../identity/identity.infra';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorDestinationService } from '../../connector-destination.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import type { ConnectorContractHarness } from '../../testing/connector-contract-kit';
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
} from '../../testing/connector-contract-kit';
import { createHubspotAdapter } from './hubspot.adapter';
import { createHubspotDriver, createHubspotDriverState, createHubspotFetch } from './hubspot.test-driver';
import { HUBSPOT_PROVIDER } from './hubspot.constants';

/**
 * Order 061 (association + contract closure) — "the actual shared Order 50
 * contract kit runs and passes against HubSpot for all applicable capabilities."
 * Every `proveXxx` here is the EXACT SAME function `connector-contract-kit.test.ts`
 * runs against the fake provider — imported, not copied — driven by the REAL
 * `createHubspotAdapter()` + a HubSpot-shaped `ConnectorTestDriver`
 * (`hubspot.test-driver.ts`) instead of the fake. No assertion was weakened; the
 * kit itself was minimally parameterized (page size, destination payload — see
 * `connector-contract-kit.ts` + `fake-provider.adapter.ts`) so both drivers share
 * it unchanged.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order061_hubspot_contract_kit_test_key_dev_only';

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
const WS = `test_ws_hubspot_kit_${STAMP}`;

test('Connector Framework contract kit: shared proofs PASS against the REAL HubSpot adapter', async (t) => {
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
  const commerce = new CommerceWriteService(db, customerContext);
  const crm = new CrmWriteService(db, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, crm);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const state = createHubspotDriverState();
  const driver = createHubspotDriver(state);
  const fetchImpl = createHubspotFetch(state);
  const adapter = createHubspotAdapter(fetchImpl, state.pageSize);
  registry.registerSource(adapter);
  registry.registerDestination(adapter);

  const harness: ConnectorContractHarness = { workspaceId: WS, provider: HUBSPOT_PROVIDER, registry, connections, orchestrator, destination, webhook };

  try {
    // capability-gated: HubSpot's OWN definition happens to satisfy the kit's
    // generic bidirectional-with-backfill/incremental/outbound shape unchanged —
    // no gating needed for this proof.
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

    await t.test('canonical mapping actually wrote through Identity Graph v2 / Customer Context (no adapter-local identity)', async () => {
      const rows = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS));
      const hubspotRows = rows.filter((r) => r.providerNamespace === HUBSPOT_PROVIDER);
      assert.ok(hubspotRows.length > 0, 'a projeção deve ter criado identifiers reais via IdentityGraphService');
    });
  } finally {
    await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS)).catch(() => undefined);
    await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
