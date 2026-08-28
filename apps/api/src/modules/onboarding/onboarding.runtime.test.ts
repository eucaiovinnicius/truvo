import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { EventContextQualityService } from '../data-quality/event-context-quality.service';
import { RadarService } from '../radars/radar.service';
import { OnboardingService } from './onboarding.service';

const A = '00000000-0000-0000-0000-000000001201'; const B = '00000000-0000-0000-0000-000000001202';
let db: Database; let onboarding: OnboardingService;
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
    const quality = new EventContextQualityService(db); const radars = new RadarService(db, quality);
    onboarding = new OnboardingService(db, { update: async () => ({}) } as never, connections as never, quality, radars);
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

  test('real canonical readiness permits an insufficient-history Radar and concurrent replay creates exactly one', async () => {
    await clean(); await onboarding.start(A, undefined); await onboarding.selectPath(A, undefined, { path: 'ecommerce' }); await onboarding.linkConnection(A, undefined, 'shopify-a'); await onboarding.verifyData(A); const ready = await onboarding.readiness(A, undefined, { outcomeKey: 'purchase' });
    assert.equal(ready.readiness.radarReadiness.status, 'not_ready');
    const request = { name: 'First truthful Radar', outcomeDefinitionId: 'purchase', predictionWindowDays: 30 as const, idempotencyKey: 'stable-first-radar-a' };
    const results = await Promise.all(Array.from({ length: 8 }, () => onboarding.createFirstRadar(A, undefined, request)));
    const ids = results.map((r) => String((r.radar as any).radar.id)); assert.equal(new Set(ids).size, 1);
    const [counts] = await db.execute(sql`select (select count(*) from radars where workspace_id=${A})::int radars,(select count(*) from onboarding_milestones where workspace_id=${A} and milestone='first_radar_created')::int milestones`);
    assert.deepEqual({ radars: Number((counts as any).radars), milestones: Number((counts as any).milestones) }, { radars: 1, milestones: 1 });
    const final = await onboarding.get(A); assert.equal(final.progress.status, 'completed'); assert.ok(final.ttfvMs! >= 0);
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
