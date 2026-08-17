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
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorDestinationService } from '../../connector-destination.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import type { ConnectorContractHarness } from '../../testing/connector-contract-kit';
import {
  proveBackfillCheckpointResume,
  proveConnectionLifecycle,
  proveCredentialFailureSeparateFromSyncHealth,
  proveSourceDefinitionCapabilities,
  proveDuplicateWebhookIsHarmless,
  proveInvalidWebhookSignatureRejected,
  provePermanentErrorStops,
  proveRateLimitReschedules,
  proveTransientRetryThenSuccess,
} from '../../testing/connector-contract-kit';
import { createStripeAdapter } from './stripe.adapter';
import { createStripeDriver, createStripeDriverState, createStripeFetch } from './stripe.test-driver';
import { STRIPE_PROVIDER } from './stripe.constants';

/**
 * Order 062 (Stripe context connector, closure 02) — "the actual shared Order 50
 * contract kit runs and passes against Stripe for every applicable capability."
 * Every `proveXxx` here is the EXACT SAME function `connector-contract-kit.test.ts`
 * runs against the fake provider and `hubspot.contract-kit.test.ts` runs against
 * HubSpot — imported, not copied — driven by the REAL `createStripeAdapter()` + a
 * Stripe-shaped `ConnectorTestDriver` (`stripe.test-driver.ts`) instead of the
 * fake/HubSpot ones. No assertion was weakened.
 *
 * Stripe is SOURCE-ONLY (`role: 'source'`, no `outbound_profile`/`outbound_event`
 * — see `stripe.constants.ts`), so this uses `proveSourceDefinitionCapabilities`
 * (not `proveDefinitionCapabilities`, which asserts a bidirectional shape) and
 * registers ONLY `registry.registerSource(adapter)` — never `registerDestination`.
 * `proveDestinationIdempotencyAndCorrelation` is intentionally NOT run: Stripe has
 * no `DestinationAdapter` to write through — there is no destination proof that
 * applies here, not a weakened one.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order062_stripe_contract_kit_test_key_dev_only';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_order062_contract_kit';
process.env.STRIPE_CONNECT_CLIENT_ID ??= 'ca_test_order062_contract_kit';
process.env.STRIPE_OAUTH_STATE_SECRET ??= 'order062_stripe_contract_kit_oauth_state_secret';

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
const WS = `test_ws_stripe_kit_${STAMP}`;

test('Connector Framework contract kit: shared proofs PASS against the REAL Stripe adapter', async (t) => {
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
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  // Constructed only to satisfy `ConnectorContractHarness`'s shape — Stripe never
  // registers a `DestinationAdapter`, so no destination proof runs against it.
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);

  const state = createStripeDriverState();
  const driver = createStripeDriver(state);
  const fetchImpl = createStripeFetch(state);
  const adapter = createStripeAdapter(fetchImpl);
  registry.registerSource(adapter);
  // No registry.registerDestination(adapter) — Stripe is source-only.

  const harness: ConnectorContractHarness = { workspaceId: WS, provider: STRIPE_PROVIDER, registry, connections, orchestrator, destination, webhook };

  try {
    await t.test('definition declares source-only capabilities (initial_backfill/incremental_pull/webhook_ingest, no outbound)', () => proveSourceDefinitionCapabilities(harness));
    await t.test('connection lifecycle: draft → authorizing → connected → disconnected', () => proveConnectionLifecycle(harness, driver));
    await t.test('credential failure is separate from sync health', () => proveCredentialFailureSeparateFromSyncHealth(harness, driver));
    await t.test('initial backfill + durable checkpoint resume', () => proveBackfillCheckpointResume(harness, driver));
    await t.test('transient failure retries then succeeds', () => proveTransientRetryThenSuccess(harness, driver));
    await t.test('permanent error stops (terminal, no infinite retry, auth failure flags credentials)', () => provePermanentErrorStops(harness, driver));
    await t.test('rate limit reschedules without dropping records', () => proveRateLimitReschedules(harness, driver));
    await t.test('duplicate webhook delivery is harmless', () => proveDuplicateWebhookIsHarmless(harness, driver));
    await t.test('invalid webhook signature fails closed', () => proveInvalidWebhookSignatureRejected(harness, driver));
    // proveDestinationIdempotencyAndCorrelation intentionally OMITTED — Stripe has
    // no DestinationAdapter/outbound capability (source-only per Order 062 scope);
    // there is nothing to write through, so no substitute proof is added either.

    await t.test('canonical mapping actually wrote through Identity Graph v2 / Customer Context (no adapter-local identity)', async () => {
      const rows = await db.select().from(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS));
      const stripeRows = rows.filter((r) => r.providerNamespace === STRIPE_PROVIDER);
      assert.ok(stripeRows.length > 0, 'a projeção deve ter criado identifiers reais via IdentityGraphService');
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
