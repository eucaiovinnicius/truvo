import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { EventContextQualityService } from '../data-quality/event-context-quality.service';
import { RadarService } from '../radars/radar.service';
import { OnboardingService } from './onboarding.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';

const A = '00000000-0000-0000-0000-000000001201'; const B = '00000000-0000-0000-0000-000000001202';
let db: Database; let onboarding: OnboardingService; let quality: EventContextQualityService; let radars: RadarService;
const connections = { get: async (ws: string, id: string) => { const [row] = await db.execute(sql`select id,provider,display_name as "displayName",lifecycle_state as "lifecycleState",credential_status as "credentialStatus" from connector_connections where workspace_id=${ws} and id=${id}`); if (!row) throw new Error('not found'); return row; } };

async function clean() { await db.execute(sql`delete from onboarding_milestones where workspace_id in (${A},${B})`); await db.execute(sql`delete from onboarding_progress where workspace_id in (${A},${B})`); await db.execute(sql`delete from radar_definition_versions where workspace_id in (${A},${B})`); await db.execute(sql`delete from radars where workspace_id in (${A},${B})`); }
async function seedCanonical(ws: string) {
  await db.execute(sql`insert into customers (workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values (${ws},'customer','identified','runtime',now(),now()) on conflict do nothing`);
  await db.execute(sql`insert into outcome_definitions (workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values (${ws},'purchase','canonical','purchase','Purchase','event','{}','runtime') on conflict do nothing`);
}

describe('Order 120 onboarding runtime acceptance', { concurrency: 1 }, () => {
  before(async () => {
    db = createDb();
    await db.execute(sql`insert into workspaces (id,name,slug) values (${A},'Onboarding A','onboarding-a'),(${B},'Onboarding B','onboarding-b') on conflict do nothing`);
    await seedCanonical(A); await seedCanonical(B);
    await db.execute(sql`insert into connector_connections (workspace_id,id,provider,role,display_name,lifecycle_state,credential_status,capabilities) values (${A},'shopify-a','shopify','source','Shopify A','healthy','valid','["read"]'),(${B},'shopify-a','shopify','source','Shopify B','healthy','valid','["read"]') on conflict do nothing`);
    quality = new EventContextQualityService(db); radars = new RadarService(db, quality);
    onboarding = new OnboardingService(db, { update: async (ws: string, input: { name?: string }) => { if (input.name) await db.execute(sql`update workspaces set name=${input.name} where id=${ws}`); return {}; } } as never, connections as never, quality, radars);
  });
  after(async () => { await clean(); await db.execute(sql`delete from connector_connections where workspace_id in (${A},${B})`); await db.execute(sql`delete from outcome_definitions where workspace_id in (${A},${B})`); await db.execute(sql`delete from customers where workspace_id in (${A},${B})`); await db.execute(sql`delete from workspaces where id in (${A},${B})`); await closeDb(db); });

  test('ecommerce, SaaS and custom paths persist and resume from server state', async () => {
    for (const path of ['ecommerce', 'saas', 'custom'] as const) {
      await clean(); await onboarding.start(A, undefined); await onboarding.selectPath(A, undefined, { path });
      if (path !== 'custom') await onboarding.linkConnection(A, undefined, 'shopify-a');
      const resumed = await new OnboardingService(db, {} as never, connections as never, new EventContextQualityService(db), new RadarService(db, new EventContextQualityService(db))).get(A);
      assert.equal(resumed.progress.selected_path, path); assert.equal(resumed.progress.current_step, path === 'custom' ? 'connect_context' : 'verify_data');
      const verified = await onboarding.verifyData(A); assert.equal(verified.detected, true);
    }
  });

  test('post-persistence failure rolls back Radar atomically; retry, concurrency and different-key replay remain singular', async () => {
    await clean(); await onboarding.start(A, undefined); await onboarding.selectPath(A, undefined, { path: 'ecommerce' }); await onboarding.linkConnection(A, undefined, 'shopify-a'); await onboarding.verifyData(A); const ready = await onboarding.readiness(A, undefined, { outcomeKey: 'purchase' });
    assert.equal(ready.readiness.radarReadiness.status, 'not_ready');
    const request = { name: 'First truthful Radar', outcomeDefinitionId: 'purchase', predictionWindowDays: 30 as const, idempotencyKey: 'stable-first-radar-a' };
    let injected = false;
    const failing = new OnboardingService(db, {} as never, connections as never, quality, radars, { afterRadarPersistence: async (_ws, radarId) => { assert.match(radarId, /^rad_/); injected = true; throw new Error('injected_after_radar_persistence'); } });
    await assert.rejects(() => failing.createFirstRadar(A, undefined, request), /injected_after_radar_persistence/); assert.equal(injected, true);
    const [rolledBack] = await db.execute(sql`select (select count(*) from radars where workspace_id=${A})::int radars,(select first_radar_id from onboarding_progress where workspace_id=${A}) first_radar_id`);
    assert.deepEqual({ radars: Number((rolledBack as { radars: number }).radars), firstRadarId: (rolledBack as { first_radar_id: string | null }).first_radar_id }, { radars: 0, firstRadarId: null });
    const results = await Promise.all(Array.from({ length: 8 }, () => onboarding.createFirstRadar(A, undefined, request)));
    const ids = results.map((r) => String((r.radar as { radar: { id: string } }).radar.id)); assert.equal(new Set(ids).size, 1);
    const differentKey = await onboarding.createFirstRadar(A, undefined, { ...request, idempotencyKey: 'different-key-after-complete' }); assert.equal((differentKey.radar as { radar: { id: string } }).radar.id, ids[0]);
    const [counts] = await db.execute(sql`select (select count(*) from radars where workspace_id=${A})::int radars,(select count(*) from onboarding_milestones where workspace_id=${A} and milestone='first_radar_created')::int milestones`);
    assert.deepEqual({ radars: Number((counts as { radars: number }).radars), milestones: Number((counts as { milestones: number }).milestones) }, { radars: 1, milestones: 1 });
    const final = await onboarding.get(A); assert.equal(final.progress.status, 'completed'); assert.equal(final.progress.first_radar_id, ids[0]); assert.ok(final.ttfvMs! >= 0);
    await db.execute(sql`update connector_connections set lifecycle_state='disconnected',credential_status='invalid' where workspace_id=${A} and id='shopify-a'`);
    assert.equal((await onboarding.get(A)).progress.status, 'blocked');
    await db.execute(sql`update connector_connections set lifecycle_state='healthy',credential_status='valid' where workspace_id=${A} and id='shopify-a'`);
    const recovered = await onboarding.get(A); assert.equal(recovered.progress.status, 'completed'); assert.equal(recovered.progress.last_error_code, null);
    const unavailable = new OnboardingService(db, {} as never, { get: async () => { throw new Error('connector_database_unavailable'); } } as never, quality, radars);
    await assert.rejects(() => unavailable.get(A), /connector_database_unavailable/);
    assert.equal((await onboarding.get(A)).progress.status, 'completed');
  });

  test('post-commit validation failure replays the same Radar and recovers its lifecycle', async () => {
    await clean(); await onboarding.start(A, undefined); await onboarding.selectPath(A, undefined, { path: 'ecommerce' }); await onboarding.linkConnection(A, undefined, 'shopify-a'); await onboarding.verifyData(A); await onboarding.readiness(A, undefined, { outcomeKey: 'purchase' });
    const request = { name: 'Recover validation', outcomeDefinitionId: 'purchase', predictionWindowDays: 30 as const, idempotencyKey: 'recover-validation' }; let failed = true;
    const flaky = new OnboardingService(db, {} as never, connections as never, quality, radars, { beforeRadarValidation: () => { if (failed) { failed = false; throw new Error('after_commit_validation_failure'); } } });
    await assert.rejects(() => flaky.createFirstRadar(A, undefined, request), /after_commit_validation_failure/);
    const [beforeReplay] = await db.execute(sql`select first_radar_id from onboarding_progress where workspace_id=${A}`); const id = String((beforeReplay as { first_radar_id: string }).first_radar_id); assert.ok(id);
    const replay = await flaky.createFirstRadar(A, undefined, request); assert.equal((replay.radar as { radar: { id: string } }).radar.id, id);
    const [count] = await db.execute(sql`select count(*)::int count from radars where workspace_id=${A}`); assert.equal(Number((count as { count: number }).count), 1);
    assert.notEqual((await radars.get(A, id)).radar.status, 'draft');
    await Promise.race([
      Promise.all(Array.from({ length: 12 }, () => radars.validate(A, id))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('concurrent_validation_pool_deadlock')), 15_000)),
    ]);
  });

  test('owner/admin may rename, member may start but receives 403 on rename and cannot mutate another workspace', async () => {
    await clean(); await db.execute(sql`update workspaces set name='Original A' where id=${A}`); await db.execute(sql`update workspaces set name='Original B' where id=${B}`);
    await onboarding.start(A, undefined, 'Owner rename', true); let [a] = await db.execute(sql`select name from workspaces where id=${A}`); assert.equal((a as { name: string }).name, 'Owner rename');
    await onboarding.start(A, undefined, 'Admin rename', true); [a] = await db.execute(sql`select name from workspaces where id=${A}`); assert.equal((a as { name: string }).name, 'Admin rename');
    await onboarding.start(B, undefined, undefined, false);
    await assert.rejects(() => onboarding.start(A, undefined, 'Forbidden member rename', false), (error: unknown) => (error as { getStatus(): number }).getStatus() === 403);
    const [names] = await db.execute(sql`select (select name from workspaces where id=${A}) a,(select name from workspaces where id=${B}) b`);
    assert.deepEqual(names, { a: 'Admin rename', b: 'Original B' });
  });

  test('onboarding source discovery is tenant-scoped and never exposes credential material', async () => {
    await db.execute(sql`update connector_connections set config=${JSON.stringify({ access_token: 'raw-token', client_secret: 'raw-secret', shop_domain: 'safe-but-raw-config-is-hidden' })}::jsonb, credentials_encrypted=${Buffer.from('encrypted-secret-payload')} where workspace_id=${A} and id='shopify-a'`);
    const sources = await (new ConnectorConnectionService(db, {} as never, {} as never)).listOnboardingSources(A);
    assert.equal(sources.length, 1); assert.equal(sources[0]!.id, 'shopify-a');
    assert.deepEqual(Object.keys(sources[0]!).sort(), ['capabilities', 'credentialStatus', 'displayName', 'id', 'lifecycleState', 'provider']);
    assert.deepEqual(sources[0], { id: 'shopify-a', provider: 'shopify', displayName: 'Shopify A', lifecycleState: 'healthy', credentialStatus: 'valid', capabilities: ['read'] });
    assert.equal(JSON.stringify(sources).match(/encrypted|access_token|refresh_token|client_secret|api_key|oauth.*secret|raw-token|raw-secret|shop_domain/i), null);
    assert.equal((await (new ConnectorConnectionService(db, {} as never, {} as never)).listOnboardingSources(B))[0]!.displayName, 'Shopify B');
  });

  test('tenant boundary, source revocation and retry reflect canonical truth', async () => {
    await clean(); await onboarding.start(A, undefined); await onboarding.selectPath(A, undefined, { path: 'ecommerce' });
    await assert.rejects(() => onboarding.linkConnection(A, undefined, 'missing-b'));
    await onboarding.linkConnection(A, undefined, 'shopify-a'); await onboarding.verifyData(A);
    assert.equal((await onboarding.get(B)).progress.selected_path, null);
    await db.execute(sql`update connector_connections set lifecycle_state='disconnected',credential_status='invalid' where workspace_id=${A} and id='shopify-a'`);
    const revoked = await onboarding.verifyData(A); assert.equal(revoked.progress.status, 'blocked'); assert.equal(revoked.source.state, 'error');
    await db.execute(sql`update connector_connections set lifecycle_state='healthy',credential_status='valid' where workspace_id=${A} and id='shopify-a'`);
    assert.equal((await onboarding.verifyData(A)).detected, true);
  });

  test('100-workspace lookup is indexed, bounded and telemetry contains no secrets or customer payload', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    for (let i = 0; i < ids.length; i++) await db.execute(sql`insert into workspaces(id,name,slug) values (${ids[i]},${`Scale ${i}`},${`onboarding-scale-${i}`}) on conflict do nothing`);
    for (const id of ids) await db.execute(sql`insert into onboarding_progress(workspace_id,status) values (${id},'in_progress') on conflict do nothing`);
    const plan = await db.execute(sql`explain (format json) select * from onboarding_progress where workspace_id=${ids[73]}`); const text = JSON.stringify(plan); assert.match(text, /Index Scan/); assert.doesNotMatch(text, /Seq Scan/);
    await onboarding.start(A, undefined); const rows = await db.execute(sql`select metadata from onboarding_milestones where workspace_id=${A}`); assert.equal(JSON.stringify(rows).match(/token|email|customer|payload|secret/gi), null);
    await db.execute(sql`delete from workspaces where id in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
  });
});
