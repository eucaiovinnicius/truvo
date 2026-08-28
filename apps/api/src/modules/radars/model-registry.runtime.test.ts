import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, createDb } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { ModelRegistryService } from './model-registry.service';

const checksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('Order 095 registry promotes, rolls back, preserves provenance and isolates tenants', async (t) => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = createDb(); const ws = '00000000-0000-0000-0000-000000000095'; const other = '00000000-0000-0000-0000-000000000096'; const radar = 'rad_registry_095';
  let unavailableObjectKey: string | undefined;
  const audit: Array<Record<string, unknown>> = []; const registry = new ModelRegistryService(db, { record: async (entry: Record<string, unknown>) => { audit.push(entry); } } as never, { verify: async (artifact: { artifactObjectKey: string }) => artifact.artifactObjectKey === unavailableObjectKey ? ({ ok: false, reason: 'checksum_mismatch' }) : ({ ok: true }) } as never);
  t.after(async () => { await db.execute(sql`delete from workspaces where id in (${ws},${other})`); await closeDb(db); });
  for (const [id, slug] of [[ws, 'order-095-registry'], [other, 'order-095-other']] as const) {
    await db.execute(sql`insert into workspaces (id,name,slug) values (${id},${slug},${slug})`);
    await db.execute(sql`insert into outcome_definitions (workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values (${id},'target','canonical','purchase','Purchase','event','{}'::jsonb,'test')`);
  }
  await db.execute(sql`insert into radars (workspace_id,id,name,status,current_definition_version) values (${ws},${radar},'Registry', 'ready_to_train',1)`);
  await db.execute(sql`insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,readiness) values (${ws},${radar},1,'target','{}'::jsonb,30,'{}'::jsonb,'{}'::jsonb)`);
  for (const id of ['request-a','request-b']) await db.execute(sql`insert into radar_training_requests (workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values (${ws},${id},${radar},1,${id},'succeeded',${id})`);
  for (const [id, request] of [['model-a','request-a'], ['model-b','request-b']] as const) await db.execute(sql`insert into radar_model_versions (workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_provider,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,serialization_format,cutoff_ranges,data_counts,metrics,calibration,provenance,validation,selection_reason,verified_at) values (${ws},${id},${radar},1,${request},'target',30,'validated','logistic_regression','propensity-v1','supabase_storage','propensity-models',${id + '.joblib'},${'supabase://propensity-models/' + id},${checksum},'joblib-v1','{}'::jsonb,'{"train":10}'::jsonb,'{"brier":0.1}'::jsonb,'{}'::jsonb,'{"worker_version":"v1"}'::jsonb,'{"artifact_verified_at":"2026-01-01"}'::jsonb,'selected',now())`);
  await registry.promote(ws, radar, 'model-a', 'user-a', 'approval');
  await registry.promote(ws, radar, 'model-b', 'user-a', 'better calibration');
  let [models] = await db.execute(sql`select count(*) filter(where status='active')::int active,count(*) filter(where status='retired')::int retired from radar_model_versions where workspace_id=${ws} and radar_id=${radar}`);
  assert.deepEqual({ active: Number((models as { active:number }).active), retired: Number((models as { retired:number }).retired) }, { active: 1, retired: 1 });
  unavailableObjectKey = 'model-a.joblib';
  await assert.rejects(() => registry.rollback(ws, radar, 'model-a', 'user-a', 'unverified rollback'), /checksum_mismatch/);
  assert.equal((await registry.active(ws, radar) as { id: string }).id, 'model-b', 'failed rollback must preserve the healthy active pointer');
  unavailableObjectKey = undefined;
  await registry.rollback(ws, radar, 'model-a', 'user-a', 'rollback evidence');
  const current = await registry.active(ws, radar) as { id: string }; assert.equal(current.id, 'model-a');
  const detail = await registry.detail(ws, radar, 'model-a') as { provenance: Record<string, unknown>; artifact_reference?: string }; assert.equal(detail.provenance.worker_version, 'v1'); assert.equal('artifact_reference' in detail, false);
  await assert.rejects(() => registry.detail(other, radar, 'model-a'), /Model not found/);
  await registry.retire(ws, radar, 'model-a', 'user-a', 'retire for incident');
  assert.equal(await registry.active(ws, radar), null); assert.ok(audit.some((entry) => entry.action === 'rolled_back'));
});
