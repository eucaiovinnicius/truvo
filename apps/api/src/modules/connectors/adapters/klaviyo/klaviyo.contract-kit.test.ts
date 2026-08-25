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
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { EngagementWriteService } from '../../engagement/engagement-write.service';
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
  provePermanentErrorStops,
  proveRateLimitReschedules,
  proveTransientRetryThenSuccess,
} from '../../testing/connector-contract-kit';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import { createKlaviyoDriver, createKlaviyoDriverState, createKlaviyoFetch } from './klaviyo.test-driver';
import { KLAVIYO_PROVIDER } from './klaviyo.constants';

/**
 * Order 063 — "the actual shared Order 50 contract kit runs and passes against
 * Klaviyo for every applicable source + destination/bidirectional capability."
 * Every `proveXxx` here is the EXACT SAME function `connector-contract-kit.test.ts`
 * runs against the fake provider and `hubspot.contract-kit.test.ts`/
 * `stripe.contract-kit.test.ts` run against their real adapters — imported, not
 * copied — driven by the REAL `createKlaviyoAdapter()` + a Klaviyo-shaped
 * `ConnectorTestDriver` (`klaviyo.test-driver.ts`) instead. No assertion was
 * weakened.
 *
 * Klaviyo declares NO `webhook_ingest` capability (see `klaviyo.adapter.ts`'s
 * DEFINITION comment): Klaviyo System Webhooks are restricted to eligible,
 * allowlisted partners and are not enabled for Truvo today. Ingestion remains
 * polling/backfill/incremental. `proveDuplicateWebhookIsHarmless`/
 * `proveInvalidWebhookSignatureRejected` are therefore intentionally OMITTED —
 * there is nothing to verify, mirroring how `stripe.contract-kit.test.ts` omits
 * `proveDestinationIdempotencyAndCorrelation` for its (source-only) provider.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order063_klaviyo_contract_kit_test_key_dev_only';
process.env.KLAVIYO_CLIENT_ID ??= 'klaviyo_test_client_id_ck';
process.env.KLAVIYO_CLIENT_SECRET ??= 'klaviyo_test_client_secret_ck';
process.env.KLAVIYO_OAUTH_STATE_SECRET ??= 'order063_klaviyo_contract_kit_oauth_state_secret';

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
const WS = `test_ws_klaviyo_kit_${STAMP}`;

test('Connector Framework contract kit: shared proofs PASS against the REAL Klaviyo adapter', async (t) => {
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
  const billing = new BillingContextWriteService(db, customerContext);
  const crm = new CrmWriteService(db, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm, new EngagementWriteService(db, customerContext));
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const state = createKlaviyoDriverState();
  const driver = createKlaviyoDriver(state);
  const fetchImpl = createKlaviyoFetch(state);
  const adapter = createKlaviyoAdapter(fetchImpl, state.pageSize);
  registry.registerSource(adapter);
  registry.registerDestination(adapter);

  const harness: ConnectorContractHarness = { workspaceId: WS, provider: KLAVIYO_PROVIDER, registry, connections, orchestrator, destination, webhook };

  try {
    await t.test('definition declares capabilities independently (source/destination/bidirectional)', () => proveDefinitionCapabilities(harness));
    await t.test('connection lifecycle: draft → authorizing → connected → disconnected', () => proveConnectionLifecycle(harness, driver));
    await t.test('credential failure is separate from sync health', () => proveCredentialFailureSeparateFromSyncHealth(harness, driver));
    await t.test('initial backfill + durable checkpoint resume', () => proveBackfillCheckpointResume(harness, driver));
    await t.test('transient failure retries then succeeds', () => proveTransientRetryThenSuccess(harness, driver));
    await t.test('permanent error stops (terminal, no infinite retry, auth failure flags credentials)', () => provePermanentErrorStops(harness, driver));
    await t.test('rate limit reschedules without dropping records', () => proveRateLimitReschedules(harness, driver));
    // proveDuplicateWebhookIsHarmless / proveInvalidWebhookSignatureRejected
    // intentionally OMITTED — see file header comment.
    await t.test('destination write idempotency + correlation + external result id', () => proveDestinationIdempotencyAndCorrelation(harness, driver));

    await t.test('canonical mapping actually wrote through Identity Graph v2 / Customer Context (no adapter-local identity)', async () => {
      const rows = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS));
      const klaviyoRows = rows.filter((r) => r.providerNamespace === KLAVIYO_PROVIDER);
      assert.ok(klaviyoRows.length > 0, 'a projeção deve ter criado identifiers reais via IdentityGraphService');
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
