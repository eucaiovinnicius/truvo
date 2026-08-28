import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { Kafka, logLevel } from 'kafkajs';
import {
  closeDb,
  createDb,
  customerOutcomes,
  customers,
  dataRetentionSettings,
  identityMergeEvents,
  integrationOutLogs,
  outcomeDefinitions,
  profileAccessLog,
  users,
  webhookLogs,
  workspaceMembers,
  workspaces,
} from '@truvo/db';
import { emitAlert, metrics, redact, type AlertHook } from '@truvo/observability';
import { productionSafetyProblems } from '../common/env.validation';
import { HealthController } from '../health/health.controller';
import { SupabaseAuthGuard } from '../modules/auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../modules/auth/guards/workspace.guard';
import { verifySupabaseJwt } from '../modules/auth/supabase-jwt.verifier';
import { AuditService } from '../modules/audit/audit.service';
import { redactOperationalLogSubject } from '../modules/data-lifecycle/erasure/subject-erasure.registry';
import { OPERATIONAL_LOG_RETENTION_DAYS, RetentionEnforcementService } from '../modules/data-lifecycle/retention-enforcement.service';
import { OutcomeOwnershipReconcilerService } from '../modules/identity/outcome-ownership-reconciler.service';
import { recordWebhookVerificationFailure, verifySignatureResult } from '../modules/webhooks/crypto/signature';
import { readBrokerConsumerLag } from '../../../consumer/src/consumer-lag';

const stamp = `${Date.now()}_${process.pid}`;
const wsA = '11111111-1111-4111-8111-111111111111';
const wsB = '22222222-2222-4222-8222-222222222222';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function jwt(secret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => (() => undefined),
    getClass: () => class RuntimeController {},
  } as unknown as ExecutionContext;
}

test('Phase A/C: exact release identity and real Supabase-compatible production auth are fail-closed and tenant-safe', async () => {
  assert.deepEqual(productionSafetyProblems({ NODE_ENV: 'production', CORS_ORIGINS: 'https://staging.test', TRUVO_DEV_AUTH_BYPASS: '1' }), [
    'TRUVO_DEV_AUTH_BYPASS não pode ser 1 em production',
    'RELEASE_COMMIT exato é obrigatório em production',
    'RELEASE_VERSION exata é obrigatória em production',
  ]);
  const priorRelease = [process.env.RELEASE_COMMIT, process.env.RELEASE_VERSION];
  process.env.RELEASE_COMMIT = '3b01c078bb3770eecca442b107a2dbe2aaf7e591';
  process.env.RELEASE_VERSION = 'prebeta-runtime';
  assert.equal(new HealthController().liveness().release.commit, process.env.RELEASE_COMMIT);

  const db = createDb();
  const secret = `supabase-prebeta-${stamp}`;
  const issuer = 'https://auth.prebeta.local/auth/v1';
  const now = Math.floor(Date.now() / 1000);
  const valid = jwt(secret, { sub: userId, email: 'operator@example.invalid', aud: 'authenticated', exp: now + 300, iss: issuer, role: 'authenticated' });
  process.env.SUPABASE_JWT_SECRET = secret;
  process.env.SUPABASE_URL = 'https://auth.prebeta.local';
  try {
    await db.insert(users).values({ id: userId, email: 'operator@example.invalid' }).onConflictDoNothing();
    await db.insert(workspaces).values([
      { id: wsA, name: 'Prebeta A', slug: `prebeta-a-${stamp}`, createdBy: userId },
      { id: wsB, name: 'Prebeta B', slug: `prebeta-b-${stamp}`, createdBy: userId },
    ]).onConflictDoNothing();
    await db.insert(workspaceMembers).values({ workspaceId: wsA, userId, role: 'owner', status: 'active' }).onConflictDoNothing();

    const auth = new SupabaseAuthGuard({ auth: { getUser: async () => { throw new Error('remote verifier must not be used'); } } } as never);
    const requestA: Record<string, unknown> = { headers: { authorization: `Bearer ${valid}`, 'x-workspace-id': wsA } };
    assert.equal(await auth.canActivate(context(requestA)), true);
    assert.equal(await new WorkspaceGuard(db, new Reflector()).canActivate(context(requestA)), true);
    assert.equal((requestA.user as { id: string }).id, userId);

    const requestB: Record<string, unknown> = { headers: { authorization: `Bearer ${valid}`, 'x-workspace-id': wsB } };
    await auth.canActivate(context(requestB));
    await assert.rejects(() => new WorkspaceGuard(db, new Reflector()).canActivate(context(requestB)), /Sem acesso/);
    assert.throws(() => verifySupabaseJwt(jwt(secret, { sub: userId, aud: 'authenticated', exp: now - 1, iss: issuer }), secret, { issuer }), /expired_token/);
    assert.throws(() => verifySupabaseJwt(`${valid.slice(0, -2)}xx`, secret, { issuer }), /invalid_signature/);
    assert.throws(() => verifySupabaseJwt('malformed', secret, { issuer }), /malformed_token/);
    await assert.rejects(() => auth.canActivate(context({ headers: {} })), /Bearer token ausente/);
  } finally {
    delete process.env.SUPABASE_JWT_SECRET;
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId)).catch(() => undefined);
    await db.delete(workspaces).where(eq(workspaces.createdBy, userId)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    await closeDb(db);
    if (priorRelease[0] === undefined) delete process.env.RELEASE_COMMIT; else process.env.RELEASE_COMMIT = priorRelease[0];
    if (priorRelease[1] === undefined) delete process.env.RELEASE_VERSION; else process.env.RELEASE_VERSION = priorRelease[1];
  }
});

test('Phase B: broker-derived lag converges and bounded webhook/log/AlertHook observability redacts secrets', async () => {
  const brokers = (process.env.KAFKA_BROKERS ?? '').split(',').filter(Boolean);
  assert.ok(brokers.length > 0, 'KAFKA_BROKERS is mandatory in prebeta runtime');
  const topic = `prebeta-lag-${stamp}`;
  const group = `prebeta-group-${stamp}`;
  const kafka = new Kafka({ clientId: `prebeta-${stamp}`, brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId: group });
  await admin.connect();
  await producer.connect();
  try {
    await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    await producer.send({ topic, messages: Array.from({ length: 7 }, (_, index) => ({ key: `k${index}`, value: `v${index}` })) });
    await admin.setOffsets({ groupId: group, topic, partitions: [{ partition: 0, offset: '0' }] });
    const behind = await readBrokerConsumerLag(admin, topic, group);
    assert.equal(behind.lag, 7);

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    let consumed = 0;
    let resolveConsumed!: () => void;
    const consumedAll = new Promise<void>((resolve) => { resolveConsumed = resolve; });
    await consumer.run({ eachMessage: async ({ topic: consumedTopic, partition, message }) => {
      consumed += 1;
      await consumer.commitOffsets([{ topic: consumedTopic, partition, offset: String(Number(message.offset) + 1) }]);
      if (consumed === 7) resolveConsumed();
    } });
    await Promise.race([consumedAll, new Promise((_, reject) => setTimeout(() => reject(new Error('consumer_timeout')), 10_000))]);
    await consumer.stop();
    const caughtUp = await readBrokerConsumerLag(admin, topic, group);
    assert.equal(caughtUp.lag, 0);

    metrics.reset();
    recordWebhookVerificationFailure('shopify', 'invalid_signature');
    recordWebhookVerificationFailure('hubspot', 'timestamp');
    recordWebhookVerificationFailure('hubspot', 'replay');
    const replay = verifySignatureResult('hubspot', { raw: Buffer.from('{}'), headers: { 'x-hubspot-signature-v3': 'x', 'x-hubspot-request-timestamp': '1' }, query: {}, secret: 'hidden', url: 'https://example.invalid/hook' });
    assert.equal(replay.reason, 'replay');
    const metricKeys = Object.keys(metrics.snapshot().counters);
    assert.equal(metricKeys.filter((key) => key.startsWith('webhook_verification_failures_total')).length, 3);
    assert.ok(metricKeys.every((key) => !/hidden|signature-value|customer|workspace/.test(key)));

    const alerts: Array<{ event: string; context: Record<string, unknown> }> = [];
    const sink: AlertHook = { emit: (alert) => { alerts.push(alert); } };
    emitAlert(sink, 'consumer_lag_critical', 'critical', { topic, group, lag: 7, token: 'never-log' });
    emitAlert(sink, 'connector_repeated_failure', 'critical', { provider: 'deterministic', secret: 'never-log' });
    emitAlert(sink, 'propensity_worker_critical', 'critical', { reason: 'artifact_checksum', apiKey: 'never-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(alerts.length, 3);
    assert.ok(alerts.every((alert) => JSON.stringify(alert.context).includes('[REDACTED]')));
    assert.deepEqual(redact({ authorization: 'Bearer secret', nested: { email: 'person@example.test', safe: 1 } }), { authorization: '[REDACTED]', nested: { email: '[REDACTED]', safe: 1 } });

    const consumerFiles = (await readdir('../consumer/src', { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      .map((entry) => `${entry.path.replaceAll('\\', '/')}/${entry.name}`);
    assert.ok(consumerFiles.length > 10, 'consumer logger scan must cover the production tree');
    for (const file of consumerFiles) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /console\.(?:log|warn|error|debug)\s*\(/, `${file} bypasses structured logging`);
    }
  } finally {
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }
});

test('Phase D: operational log retention is bounded, tenant-safe, idempotent and subject audit becomes non-identifying', async () => {
  const db = createDb();
  const a = `prebeta_ops_a_${stamp}`;
  const b = `prebeta_ops_b_${stamp}`;
  const old = new Date(Date.now() - 900 * 86_400_000);
  const current = new Date();
  try {
    await db.insert(dataRetentionSettings).values([{ workspaceId: a, tombstonePurgeAfterDays: 30 }, { workspaceId: b, tombstonePurgeAfterDays: 30 }]);
    await db.insert(profileAccessLog).values([
      { id: `pal_old_${stamp}`, workspaceId: a, canonicalId: 'customer-erased', accessedBy: 'operator', accessedByEmail: null, action: 'view_profile', metadata: { search_type: 'id' }, at: old },
      { id: `pal_current_${stamp}`, workspaceId: a, canonicalId: 'customer-erased', accessedBy: 'operator', accessedByEmail: null, action: 'view_profile', metadata: {}, at: current },
      { id: `pal_other_${stamp}`, workspaceId: b, canonicalId: 'customer-erased', accessedBy: 'operator', accessedByEmail: null, action: 'view_profile', metadata: {}, at: old },
    ]);
    await db.insert(integrationOutLogs).values([
      { id: `iol_old_${stamp}`, workspaceId: a, platform: 'meta_capi', eventId: `evt_old_${stamp}`, status: 'sent', createdAt: old },
      { id: `iol_current_${stamp}`, workspaceId: a, platform: 'meta_capi', eventId: `evt_current_${stamp}`, status: 'sent', createdAt: current },
      { id: `iol_other_${stamp}`, workspaceId: b, platform: 'meta_capi', eventId: `evt_other_${stamp}`, status: 'sent', createdAt: old },
    ]);
    await db.insert(webhookLogs).values([
      { id: `whl_old_${stamp}`, workspaceId: a, provider: 'stripe', status: 'processed', retryPayload: { context: { email_hash: 'sensitive-hash' } }, receivedAt: old, createdAt: old },
      { id: `whl_current_${stamp}`, workspaceId: a, provider: 'stripe', status: 'processed', retryPayload: { context: { email_hash: 'sensitive-hash' } }, receivedAt: current, createdAt: current },
      { id: `whl_other_${stamp}`, workspaceId: b, provider: 'stripe', status: 'processed', retryPayload: { context: { email_hash: 'other' } }, receivedAt: old, createdAt: old },
    ]);

    assert.deepEqual(OPERATIONAL_LOG_RETENTION_DAYS, { profile_access_log: 730, integration_out_logs: 180, webhook_logs: 30 });
    const service = new RetentionEnforcementService(db, new AuditService(db));
    const first = await service.sweepWorkspace(a);
    assert.equal(first.purged.profile_access_log, 1);
    assert.equal(first.purged.integration_out_logs, 1);
    assert.equal(first.purged.webhook_logs, 1);
    const terminal = await db.select().from(webhookLogs).where(eq(webhookLogs.id, `whl_current_${stamp}`));
    assert.equal(terminal[0]?.retryPayload, null);
    assert.equal((await db.select().from(profileAccessLog).where(eq(profileAccessLog.workspaceId, b))).length, 1);

    const erased = await redactOperationalLogSubject({ db, ch: {} as never, workspaceId: a, customerId: 'customer-erased' });
    assert.equal(erased.status, 'completed');
    const auditRow = await db.select().from(profileAccessLog).where(eq(profileAccessLog.id, `pal_current_${stamp}`));
    assert.equal(auditRow[0]?.canonicalId, '[erased]');
    assert.deepEqual(auditRow[0]?.metadata, { subjectErased: true });
    const second = await service.sweepWorkspace(a);
    assert.equal(second.purged.profile_access_log, 0);
    assert.equal(second.purged.integration_out_logs, 0);
    assert.equal(second.purged.webhook_logs, 0);
  } finally {
    await db.delete(profileAccessLog).where(and(eq(profileAccessLog.workspaceId, a))).catch(() => undefined);
    await db.delete(profileAccessLog).where(and(eq(profileAccessLog.workspaceId, b))).catch(() => undefined);
    await db.delete(integrationOutLogs).where(eq(integrationOutLogs.workspaceId, a)).catch(() => undefined);
    await db.delete(integrationOutLogs).where(eq(integrationOutLogs.workspaceId, b)).catch(() => undefined);
    await db.delete(webhookLogs).where(eq(webhookLogs.workspaceId, a)).catch(() => undefined);
    await db.delete(webhookLogs).where(eq(webhookLogs.workspaceId, b)).catch(() => undefined);
    await db.delete(dataRetentionSettings).where(eq(dataRetentionSettings.workspaceId, a)).catch(() => undefined);
    await db.delete(dataRetentionSettings).where(eq(dataRetentionSettings.workspaceId, b)).catch(() => undefined);
    await closeDb(db);
  }
});

test('Phase F: historical outcome ownership advances A→B without event replay and immutable facts remain byte-for-byte stable', async () => {
  const db = createDb();
  const a = `prebeta_identity_a_${stamp}`;
  const other = `prebeta_identity_b_${stamp}`;
  const source = `cus_source_${stamp}`;
  const target = `cus_target_${stamp}`;
  const otherCustomer = `cus_other_${stamp}`;
  const outcomeId = `out_${stamp}`;
  const observedAt = new Date('2025-01-02T03:04:05.000Z');
  const provenance = { source_record_id: `evt_source_${stamp}`, metadata: { provider: 'deterministic' } };
  try {
    await db.insert(customers).values([
      { workspaceId: a, id: source, status: 'merged', mergedIntoCustomerId: target, sourceNamespace: 'prebeta', firstSeenAt: observedAt, lastSeenAt: observedAt },
      { workspaceId: a, id: target, status: 'identified', sourceNamespace: 'prebeta', firstSeenAt: observedAt, lastSeenAt: observedAt },
      { workspaceId: other, id: otherCustomer, status: 'identified', sourceNamespace: 'prebeta', firstSeenAt: observedAt, lastSeenAt: observedAt },
    ]);
    await db.insert(outcomeDefinitions).values([
      { workspaceId: a, id: `od_${stamp}`, outcomeNamespace: 'prebeta', outcomeKey: 'purchase', name: 'Purchase', kind: 'event', definition: { event_name: 'purchase' }, sourceNamespace: 'prebeta' },
      { workspaceId: other, id: `od_other_${stamp}`, outcomeNamespace: 'prebeta', outcomeKey: 'purchase', name: 'Purchase', kind: 'event', definition: { event_name: 'purchase' }, sourceNamespace: 'prebeta' },
    ]);
    await db.insert(customerOutcomes).values([
      { workspaceId: a, id: outcomeId, customerId: source, outcomeDefinitionId: `od_${stamp}`, outcomeNamespace: 'prebeta', outcomeKey: 'purchase', dedupeKey: `order_${stamp}`, eventId: `evt_${stamp}`, value: '123.45', currency: 'BRL', sourceNamespace: 'prebeta', provenance, observedAt },
      { workspaceId: other, id: `out_other_${stamp}`, customerId: otherCustomer, outcomeDefinitionId: `od_other_${stamp}`, outcomeNamespace: 'prebeta', outcomeKey: 'purchase', dedupeKey: `order_other_${stamp}`, eventId: `evt_other_${stamp}`, value: '9.99', currency: 'USD', sourceNamespace: 'prebeta', provenance: {}, observedAt },
    ]);
    await db.insert(identityMergeEvents).values({ workspaceId: a, id: `ime_${stamp}`, operation: 'merge', sourceCustomerId: source, targetCustomerId: target, reason: 'prebeta-runtime', evidence: { movedIdentifiers: [], sourceStatusBeforeMerge: 'identified' }, sourceNamespace: 'prebeta', actor: { type: 'system', label: 'prebeta' }, at: new Date() });

    const before = (await db.select().from(customerOutcomes).where(eq(customerOutcomes.id, outcomeId)))[0]!;
    const service = new OutcomeOwnershipReconcilerService(db);
    assert.deepEqual(await service.reconcileWorkspace(a), { processed: 1, remaining: false });
    const after = (await db.select().from(customerOutcomes).where(eq(customerOutcomes.id, outcomeId)))[0]!;
    assert.equal(after.customerId, target);
    for (const key of ['id', 'eventId', 'value', 'currency', 'observedAt', 'outcomeDefinitionId', 'outcomeNamespace', 'outcomeKey', 'dedupeKey', 'sourceNamespace', 'provenance'] as const) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(await service.reconcileWorkspace(a), { processed: 0, remaining: false });
    const untouched = (await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, other)))[0]!;
    assert.equal(untouched.customerId, otherCustomer);
  } finally {
    await db.delete(identityMergeEvents).where(eq(identityMergeEvents.workspaceId, a)).catch(() => undefined);
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, a)).catch(() => undefined);
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, other)).catch(() => undefined);
    await db.delete(outcomeDefinitions).where(eq(outcomeDefinitions.workspaceId, a)).catch(() => undefined);
    await db.delete(outcomeDefinitions).where(eq(outcomeDefinitions.workspaceId, other)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, a)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, other)).catch(() => undefined);
    await closeDb(db);
  }
});
