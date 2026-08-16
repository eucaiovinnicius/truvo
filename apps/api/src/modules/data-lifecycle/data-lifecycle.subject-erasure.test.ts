import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import {
  createDb, closeDb, customers, customerIdentifiers, customerOutcomes, dataLifecycleRequests, dataLifecycleStoreResults,
  identityLinks, identityMerges, identityConflicts, identityMergeEvents, identitySuppressions,
} from '@truvo/db';
import { DataLifecycleService } from './data-lifecycle.service';
import { closeClickHouse, getClickHouse } from './erasure/clickhouse.infra';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { CustomerContextService, LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { AuditService } from '../audit/audit.service';

/**
 * Order 055 §2/§3 — subject erasure PROPAGATION, store by store, against real
 * Postgres + real ClickHouse. Also proves §1's partial-failure visibility and
 * retry-resume-only-incomplete-stores behavior, using a genuinely broken
 * ClickHouse client (unreachable host) to force one store to fail without faking
 * the failure — the retry then points at a REAL client and completes.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order055_subject_erasure_test_key_dev_only';

let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const pgUrl = process.env.DATABASE_URL;
  if (!pgUrl) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(pgUrl, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
  } catch {
    reachable = false;
    await probe.end({ timeout: 1 }).catch(() => undefined);
    return reachable;
  }
  await probe.end({ timeout: 1 }).catch(() => undefined);
  try {
    await getClickHouse().query({ query: 'select 1', format: 'JSONEachRow' });
    reachable = true;
  } catch {
    reachable = false;
  }
  return reachable;
}

const STAMP = Date.now();
const WS = `test_ws_erasure_${STAMP}`;

test('subject deletion: every store erased, ClickHouse rows deleted, evidence redacted, identifiers suppressed', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL/ClickHouse não alcançáveis neste ambiente — ver HANDOFF (Postgres/ClickHouse dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const audit = new AuditService(db);
  const svc = new DataLifecycleService(db, customerContext, audit, suppression);
  const ch = getClickHouse();
  const now = new Date();

  const targetCanonical = `usr_erasure_${STAMP}`;
  const anonId = `anon_erasure_${STAMP}`;
  const emailHash = `email_erasure_${STAMP}`;

  try {
    // ── seed: a v2 customer with v1-bridged + v2-native identifiers, an outcome, a
    // conflict, a merge event, and matching ClickHouse rows ──
    await customerContext.synchronizeLegacyIdentity(WS, targetCanonical, [
      { identifier: anonId, type: 'anonymous_id' },
      { identifier: emailHash, type: 'email_hash' },
    ], [], now);
    await db.insert(identityLinks).values([
      { id: `idl_${STAMP}`, workspaceId: WS, identifier: anonId, identifierType: 'anonymous_id', canonicalId: targetCanonical, firstSeen: now },
    ]).onConflictDoNothing();

    await db.insert(customerOutcomes).values({
      workspaceId: WS, id: `oco_${STAMP}`, customerId: targetCanonical, outcomeDefinitionId: `ocd_${STAMP}`,
      outcomeNamespace: 'commerce', outcomeKey: 'purchase', dedupeKey: `ord_${STAMP}`, eventId: `evt_${STAMP}`,
      sourceNamespace: 'order055-test', observedAt: now,
    }).catch(() => undefined);

    // a conflict + merge event that reference the target customer, carrying identifier values to redact.
    const otherCustomer = `usr_other_${STAMP}`;
    await db.insert(customers).values({ workspaceId: WS, id: otherCustomer, status: 'identified', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing();
    await identityGraph.recordConflict({
      workspaceId: WS, existingCustomerId: targetCanonical, incomingCustomerId: otherCustomer,
      providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: emailHash,
      reason: 'test_conflict', sourceNamespace: 'order055-test', detectedAt: now,
    });

    await ch.insert({
      table: 'events',
      values: [{
        event_id: `evt_ch_${STAMP}`, event_name: 'page_view', source: 'pixel', workspace_id: WS,
        timestamp: now.toISOString().replace('T', ' ').replace('Z', ''), received_at: now.toISOString().replace('T', ' ').replace('Z', ''),
        anonymous_id: anonId, user_id: '', session_id: '', click_id: '', order_id: '',
        utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '', page_url: '', referrer: '',
        ip_country: '', ip_city: '', device_type: '', os: '', browser: '', user_agent: '',
        value: 0, currency: '', is_bot: 0, properties: '{}', context: '{}', raw: '{}',
      }],
      format: 'JSONEachRow',
    });
    await ch.insert({
      table: 'touchpoints',
      values: [{
        workspace_id: WS, canonical_id: targetCanonical, ts: now.toISOString().replace('T', ' ').replace('Z', ''),
        channel: 'direct', utm_source: '', utm_medium: '', utm_campaign: '', click_id: '', order_id: '',
        source: 'pixel', event_id: `evt_ch_${STAMP}`, value: 0, is_bot: 0,
      }],
      format: 'JSONEachRow',
    });

    // ── execute ──
    const result = await svc.requestSubjectDeletion(WS, targetCanonical, { id: 'user_owner' });
    assert.equal(result.status, 'completed', JSON.stringify(result.stores));
    assert.equal(result.stores.customer_context?.status, 'completed');
    assert.equal(result.stores.identity_v1?.status, 'completed');
    assert.equal(result.stores.identity_graph_v2_evidence?.status, 'completed');
    assert.equal(result.stores.clickhouse_events_touchpoints?.status, 'completed');

    // Postgres: tombstoned.
    const [customerRow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, targetCanonical)));
    assert.notEqual(customerRow!.deletedAt, null);

    // v1: tombstoned (not value-anonymized — deleted_at is the erasure signal here).
    const [linkRow] = await db.select().from(identityLinks).where(and(eq(identityLinks.workspaceId, WS), eq(identityLinks.identifier, anonId)));
    assert.notEqual(linkRow!.deletedAt, null);

    // v2 evidence: RETAINED but redacted.
    const [conflictRow] = await db.select().from(identityConflicts).where(and(eq(identityConflicts.workspaceId, WS), eq(identityConflicts.existingCustomerId, targetCanonical)));
    assert.ok(conflictRow, 'o registro de conflito deve continuar existindo (auditoria)');
    assert.equal(conflictRow!.identifierValue, '[erased]');

    // ClickHouse: rows genuinely gone.
    const eventsLeft = await ch.query({ query: `select count() as n from events where workspace_id = {ws:String} and event_id = {id:String}`, query_params: { ws: WS, id: `evt_ch_${STAMP}` }, format: 'JSONEachRow' });
    const eventsCount = (await eventsLeft.json<{ n: string }>()) as unknown as Array<{ n: string }>;
    assert.equal(Number(eventsCount[0]!.n), 0, 'o evento do titular deve estar fisicamente apagado do ClickHouse');

    const touchpointsLeft = await ch.query({ query: `select count() as n from touchpoints where workspace_id = {ws:String} and canonical_id = {id:String}`, query_params: { ws: WS, id: targetCanonical }, format: 'JSONEachRow' });
    const touchpointsCount = (await touchpointsLeft.json<{ n: string }>()) as unknown as Array<{ n: string }>;
    assert.equal(Number(touchpointsCount[0]!.n), 0, 'o touchpoint do titular deve estar fisicamente apagado do ClickHouse');

    // suppression: created for every identifier the subject was known under.
    const suppressedAnon = await suppression.isSuppressed(WS, { providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'anonymous_id', identifierValue: anonId });
    assert.equal(suppressedAnon, true);
    const suppressedEmail = await suppression.isSuppressed(WS, { providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: emailHash });
    assert.equal(suppressedEmail, true);

    // idempotent replay: nothing left to process, still reports completed.
    const replay = await svc.requestSubjectDeletion(WS, targetCanonical, { id: 'user_owner' });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.stores.customer_context?.processedCount, 0);
  } finally {
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS)).catch(() => undefined);
    await db.delete(identityConflicts).where(eq(identityConflicts.workspaceId, WS)).catch(() => undefined);
    await db.delete(identityMergeEvents).where(eq(identityMergeEvents.workspaceId, WS)).catch(() => undefined);
    await db.delete(identityLinks).where(eq(identityLinks.workspaceId, WS)).catch(() => undefined);
    await db.delete(identityMerges).where(eq(identityMerges.workspaceId, WS)).catch(() => undefined);
    await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, WS)).catch(() => undefined);
    await db.delete(dataLifecycleStoreResults).where(eq(dataLifecycleStoreResults.workspaceId, WS)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, WS)).catch(() => undefined);
    await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    await ch.command({ query: `ALTER TABLE events DELETE WHERE workspace_id = {ws:String}`, query_params: { ws: WS }, clickhouse_settings: { mutations_sync: '1' } }).catch(() => undefined);
    await ch.command({ query: `ALTER TABLE touchpoints DELETE WHERE workspace_id = {ws:String}`, query_params: { ws: WS }, clickhouse_settings: { mutations_sync: '1' } }).catch(() => undefined);
    await closeClickHouse().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});

test('subject deletion: partial store failure is visible; retry resumes ONLY the incomplete store', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL/ClickHouse não alcançáveis neste ambiente — ver HANDOFF (Postgres/ClickHouse dev unreachable)');
    return;
  }

  const db = createDb();
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const audit = new AuditService(db);
  const svc = new DataLifecycleService(db, customerContext, audit, suppression);
  const now = new Date();
  const customerId = `usr_partial_${STAMP}`;

  try {
    await db.insert(customers).values({ workspaceId: WS, id: customerId, status: 'anonymous', sourceNamespace: 'order055-test', firstSeenAt: now, lastSeenAt: now });

    // Force the ClickHouse store to fail for THIS run by pointing CLICKHOUSE_URL at
    // an unreachable host — a genuine failure, not a mocked one.
    const realUrl = process.env.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_URL = 'http://127.0.0.1:1';
    await closeClickHouse(); // drop the memoized (working) client so the next getClickHouse() picks up the broken URL

    const first = await svc.requestSubjectDeletion(WS, customerId, { id: 'user_owner' });
    assert.equal(first.status, 'failed', 'um store falho deve tornar o request TODO visível como failed — nunca completed parcial');
    assert.equal(first.stores.customer_context?.status, 'completed', 'stores que funcionaram continuam visíveis como completed');
    assert.equal(first.stores.clickhouse_events_touchpoints?.status, 'failed');

    const [customerRow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, customerId)));
    assert.notEqual(customerRow!.deletedAt, null, 'o store que teve sucesso NÃO é revertido pelo outro falhar (resultado visível por store)');

    // restore a working ClickHouse and retry — must resume ONLY the failed store.
    process.env.CLICKHOUSE_URL = realUrl;
    await closeClickHouse();

    const storeResultsBefore = await db.select().from(dataLifecycleStoreResults).where(and(eq(dataLifecycleStoreResults.workspaceId, WS), eq(dataLifecycleStoreResults.requestId, first.requestId)));
    const customerContextAttemptsBefore = storeResultsBefore.find((r) => r.store === 'customer_context')!.attempts;

    const retried = await svc.retrySubjectDeletion(WS, first.requestId, { id: 'user_owner' });
    assert.equal(retried.status, 'completed', JSON.stringify(retried.stores));
    assert.equal(retried.stores.clickhouse_events_touchpoints?.status, 'completed');

    const storeResultsAfter = await db.select().from(dataLifecycleStoreResults).where(and(eq(dataLifecycleStoreResults.workspaceId, WS), eq(dataLifecycleStoreResults.requestId, first.requestId)));
    const customerContextAttemptsAfter = storeResultsAfter.find((r) => r.store === 'customer_context')!.attempts;
    assert.equal(customerContextAttemptsAfter, customerContextAttemptsBefore, 'o store JÁ completo não deve ser reexecutado pelo retry');
  } finally {
    await closeClickHouse().catch(() => undefined);
    const ch = getClickHouse();
    await ch.command({ query: `ALTER TABLE events DELETE WHERE workspace_id = {ws:String}`, query_params: { ws: WS }, clickhouse_settings: { mutations_sync: '1' } }).catch(() => undefined);
    await ch.command({ query: `ALTER TABLE touchpoints DELETE WHERE workspace_id = {ws:String}`, query_params: { ws: WS }, clickhouse_settings: { mutations_sync: '1' } }).catch(() => undefined);
    await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, WS)).catch(() => undefined);
    await db.delete(dataLifecycleStoreResults).where(eq(dataLifecycleStoreResults.workspaceId, WS)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    await closeClickHouse().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
