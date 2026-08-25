import assert from 'node:assert/strict';
import type { ConnectorConnectionService } from '../connector-connection.service';
import type { ConnectorSyncOrchestratorService } from '../connector-sync-orchestrator.service';
import type { ConnectorDestinationService } from '../connector-destination.service';
import type { ConnectorWebhookService } from '../connector-webhook.service';
import type { ConnectorRegistryService } from '../connector-registry.service';
import type { ConnectorRole, NormalizedRecord } from '../contracts';
import type { ConnectorTestDriver } from './fake-provider.adapter';

/**
 * Order 050 §"Contract test kit" — reusable proofs, parameterized over a harness +
 * driver rather than the fake adapter directly. A future real adapter (Orders
 * 60–63) provides its OWN `ConnectorTestDriver` (e.g. against a sandbox) and its
 * OWN harness wiring the SAME framework services — these `proveXxx` functions run
 * unchanged. Each throws (via `node:assert`) on failure; callers wrap them in their
 * own `test()` blocks.
 */
export interface ConnectorContractHarness {
  workspaceId: string;
  provider: string;
  registry: ConnectorRegistryService;
  connections: ConnectorConnectionService;
  orchestrator: ConnectorSyncOrchestratorService;
  destination: ConnectorDestinationService;
  webhook: ConnectorWebhookService;
}

async function freshConnection(h: ConnectorContractHarness, role: ConnectorRole = 'bidirectional') {
  return h.connections.create(h.workspaceId, { provider: h.provider, role, displayName: `contract-kit-${role}-${Date.now()}-${Math.random()}` });
}

export async function proveDefinitionCapabilities(h: ConnectorContractHarness): Promise<void> {
  const def = h.registry.getDefinition(h.provider);
  assert.ok(def, 'provider deve estar registrado');
  assert.ok(def!.capabilities.includes('initial_backfill'), 'source-only: initial_backfill');
  assert.ok(def!.capabilities.includes('incremental_pull'), 'source-only: incremental_pull');
  assert.ok(def!.capabilities.includes('outbound_profile') || def!.capabilities.includes('outbound_event'), 'destination-only: outbound capability');
  assert.equal(def!.role, 'bidirectional');
}

/** Applicable subset for a real source-only adapter. Kept in the shared kit so
 * Stripe/Shopify do not replace framework assertions with provider-only ones. */
export async function proveSourceDefinitionCapabilities(h: ConnectorContractHarness): Promise<void> {
  const def = h.registry.getDefinition(h.provider);
  assert.ok(def, 'provider deve estar registrado');
  assert.equal(def!.role, 'source');
  assert.ok(def!.capabilities.includes('initial_backfill'));
  assert.ok(def!.capabilities.includes('incremental_pull'));
  assert.ok(def!.capabilities.includes('webhook_ingest'));
  assert.ok(!def!.capabilities.includes('outbound_profile'));
}

export async function proveConnectionLifecycle(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h);
  assert.equal(conn.lifecycleState, 'draft');
  assert.equal(conn.credentialStatus, 'unset');

  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const afterCreds = await h.connections.get(h.workspaceId, conn.id);
  assert.equal(afterCreds.lifecycleState, 'authorizing', 'credenciais enviadas mas ainda não testadas');

  const result = await h.connections.testConnection(h.workspaceId, conn.id);
  assert.equal(result.ok, true);
  const afterTest = await h.connections.get(h.workspaceId, conn.id);
  assert.equal(afterTest.lifecycleState, 'connected');
  assert.equal(afterTest.credentialStatus, 'valid');

  const disconnected = await h.connections.disconnect(h.workspaceId, conn.id);
  assert.equal(disconnected.lifecycleState, 'disconnected');
}

export async function proveCredentialFailureSeparateFromSyncHealth(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  await h.connections.testConnection(h.workspaceId, conn.id);
  const beforeSync = await h.connections.get(h.workspaceId, conn.id);
  assert.equal(beforeSync.credentialStatus, 'valid');

  driver.seedCatalog([]);
  driver.forceNextPull('transient_error');
  await h.orchestrator.runBackfill(h.workspaceId, conn.id, `stream_${Date.now()}`);

  const afterFailedSync = await h.connections.get(h.workspaceId, conn.id);
  assert.equal(afterFailedSync.credentialStatus, 'valid', 'sync transitório falho NÃO deve invalidar credenciais válidas');
  assert.notEqual(afterFailedSync.lifecycleState, 'connected', 'lifecycle deve refletir o problema de sync');

  // separately: a genuine credential failure DOES flip credentialStatus.
  const conn2 = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn2.id, driver.invalidCredentials());
  const badTest = await h.connections.testConnection(h.workspaceId, conn2.id);
  assert.equal(badTest.ok, false);
  const afterBadTest = await h.connections.get(h.workspaceId, conn2.id);
  assert.equal(afterBadTest.credentialStatus, 'invalid');
}

export async function proveBackfillCheckpointResume(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const stream = `backfill_${Date.now()}`;

  // Generic across ANY driver's own page size: 2 full pages + 1 partial page —
  // the SAME shape the fake provider's hardcoded "5 records / page size 2" used
  // to assert, just derived instead of fixed, so a real adapter's (possibly
  // different, possibly test-overridden) page size shares this proof unweakened.
  const pageSize = driver.pageSize();
  const catalogSize = pageSize * 2 + 1;
  const catalog: NormalizedRecord[] = Array.from({ length: catalogSize }, (_, i) => ({
    identifiers: [{ providerNamespace: h.provider, identifierType: 'external_id' as const, identifierValue: `bf_${stream}_${i}` }],
    observedAt: new Date().toISOString(),
  }));
  driver.seedCatalog(catalog);

  const first = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.recordsRead, pageSize, `primeira página: ${pageSize} registros (page size do driver)`);
  assert.equal(first.hasMore, true);

  const second = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.recordsRead, pageSize, 'segunda chamada deve RETOMAR do checkpoint, não recomeçar do zero');
  assert.notEqual(second.nextCursor, first.nextCursor);

  const third = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(third.recordsRead, 1);
  assert.equal(third.hasMore, false, `catálogo de ${catalogSize} em páginas de ${pageSize} → última página termina o backfill`);

  // idempotent replay: re-running with the checkpoint already at "no more pages"
  // must not re-fetch/re-apply — proven by the SAME final cursor without a 4th read.
  const callsBefore = driver.pullCallCount();
  const replay = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(replay.replayedFromCache, true);
  assert.equal(driver.pullCallCount(), callsBefore, 'replay não deve chamar o adapter de novo');
}

export async function proveTransientRetryThenSuccess(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const stream = `retry_${Date.now()}`;
  driver.seedCatalog([{ identifiers: [{ providerNamespace: h.provider, identifierType: 'external_id', identifierValue: `retry_${stream}` }], observedAt: new Date().toISOString() }]);

  driver.forceNextPull('transient_error');
  const failed = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(failed.status, 'pending', 'falha transitória agenda retry (não é terminal)');

  // same logical run (same checkpoint boundary) retried — succeeds this time.
  const retried = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.replayedFromCache, false, 'retry de fato reexecutou o adapter, não veio do cache');
}

export async function provePermanentErrorStops(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  await h.connections.testConnection(h.workspaceId, conn.id);
  const stream = `permfail_${Date.now()}`;
  driver.seedCatalog([]);

  driver.forceNextPull('permanent_error');
  const result = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(result.status, 'failed', 'erro permanente (401) deve ser terminal, visível');

  const afterFailure = await h.connections.get(h.workspaceId, conn.id);
  // OAuth providers may distinguish a revoked/invalid refresh credential from a
  // normal 401 by moving the connection to explicit reauthorization-required
  // (`disconnected`). Static-key providers retain the legacy `error` state.
  assert.ok(['error', 'disconnected'].includes(afterFailure.lifecycleState));
  assert.equal(afterFailure.credentialStatus, 'invalid', '401 É uma falha de credencial genuína — diferente de uma falha de sync qualquer');

  // A revoked OAuth credential is explicitly disconnected and must not be
  // polled again. Other permanent failures remain replayable from the terminal
  // ledger row without another provider call.
  if (afterFailure.lifecycleState === 'disconnected') {
    await assert.rejects(() => h.orchestrator.runBackfill(h.workspaceId, conn.id, stream));
  } else {
    const replay = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
    assert.equal(replay.status, 'failed');
    assert.equal(replay.replayedFromCache, true);
  }
}

export async function proveRateLimitReschedules(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const stream = `ratelimit_${Date.now()}`;
  const record: NormalizedRecord = { identifiers: [{ providerNamespace: h.provider, identifierType: 'external_id', identifierValue: `rl_${stream}` }], observedAt: new Date().toISOString() };
  driver.seedCatalog([record]);

  driver.forceNextPull('rate_limited');
  const limited = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(limited.status, 'rate_limited', 'rate limit deve ser um status PRÓPRIO, observável — não um erro genérico');

  // never silently drop records: the catalog is untouched, and retrying actually
  // reads it (the record was never marked "processed" by the failed attempt).
  const retried = await h.orchestrator.runBackfill(h.workspaceId, conn.id, stream);
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.recordsRead, 1);
}

export async function proveDuplicateWebhookIsHarmless(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const deliveryId = `delivery_${Date.now()}`;
  const request = driver.webhookRequest(`webhook_customer_${deliveryId}`, { deliveryId });

  const first = await h.webhook.handleWebhook(h.workspaceId, conn.id, request);
  assert.equal(first.status, 'ok');

  const second = await h.webhook.handleWebhook(h.workspaceId, conn.id, request);
  assert.equal(second.status, 'duplicate', 'a MESMA entrega repetida deve ser inofensiva, não reprocessada');
}

export async function proveInvalidWebhookSignatureRejected(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'source');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const request = driver.webhookRequest(`bad_sig_${Date.now()}`, { valid: false });

  const result = await h.webhook.handleWebhook(h.workspaceId, conn.id, request);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_signature');
}

export async function proveDestinationIdempotencyAndCorrelation(h: ConnectorContractHarness, driver: ConnectorTestDriver): Promise<void> {
  const conn = await freshConnection(h, 'destination');
  await h.connections.setCredentials(h.workspaceId, conn.id, driver.validCredentials());
  const idempotencyKey = `write_${Date.now()}`;
  const input = { idempotencyKey, correlationId: `corr_${Date.now()}`, kind: 'profile_upsert', payload: driver.destinationWritePayload() };

  const first = await h.destination.write(h.workspaceId, conn.id, input);
  assert.equal(first.status, 'sent');
  assert.ok(first.externalResultId);

  const callsBefore = driver.writeCallCount();
  const second = await h.destination.write(h.workspaceId, conn.id, input);
  assert.equal(second.status, 'sent');
  assert.equal(second.externalResultId, first.externalResultId, 'a MESMA idempotencyKey deve devolver o MESMO resultado (correlação preservada)');
  assert.equal(driver.writeCallCount(), callsBefore, 'segunda chamada não deve invocar o adapter de novo');
}
