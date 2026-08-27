import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { RadarService, type AudienceAst } from './radar.service';

const WORKSPACE_A = '00000000-0000-0000-0000-000000000801';
const WORKSPACE_B = '00000000-0000-0000-0000-000000000802';
const WORKSPACES = [WORKSPACE_A, WORKSPACE_B];

type QualityResult = { criticalCount: number; warningsCount: number; identityCoverage?: number; contextCoverage?: { score: number }; radarReadiness?: { reasonCodes: string[] } };
type RadarView = {
  radar: { id: string; name: string; status: string; current_definition_version: number; current_model_reference: string | null };
  definition: {
    version: number;
    audience_ast: AudienceAst;
    prediction_window_days: number;
    activation_destination: { connectionId: string; capability: 'activation' } | null;
    readiness: Record<string, unknown> | null;
  };
  activationReadiness: { status: 'ready' | 'unavailable' | 'not_configured'; reasonCode: string | null };
};

let db: Database;

function service(quality: QualityResult = { criticalCount: 0, warningsCount: 0, identityCoverage: 1, contextCoverage: { score: 100 } }) {
  return new RadarService(db, { evaluate: async () => quality } as never);
}

async function deleteFixture() {
  await db.execute(sql`delete from radar_training_requests where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from radar_definition_versions where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from radars where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from customer_outcomes where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from customer_traits where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from customer_identifiers where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from outcome_definitions where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from connector_connections where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
  await db.execute(sql`delete from customers where workspace_id in (${WORKSPACE_A},${WORKSPACE_B})`);
}

async function seedFixture() {
  for (const workspaceId of WORKSPACES) {
    await db.execute(sql`insert into customers (workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values
      (${workspaceId},'c1','identified','test',now() - interval '90 days',now()),
      (${workspaceId},'c2','identified','test',now() - interval '90 days',now()),
      (${workspaceId},'c3','identified','test',now() - interval '90 days',now()),
      (${workspaceId},'c4','anonymous','test',now() - interval '90 days',now())`);
    await db.execute(sql`insert into customer_identifiers (workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at) values
      (${workspaceId},'i1','c1','external_id','test','shared-1','test',now() - interval '90 days',now()),
      (${workspaceId},'i2','c2','external_id','test','shared-2','test',now() - interval '90 days',now()),
      (${workspaceId},'i3','c3','external_id','test','shared-3','test',now() - interval '90 days',now())`);
    await db.execute(sql`insert into outcome_definitions (workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values
      (${workspaceId},'purchase','canonical','purchase','Purchase','event','{}'::jsonb,'test')`);
    await db.execute(sql`insert into customer_traits (workspace_id,id,customer_id,trait_namespace,trait_key,value_type,value,source_namespace,observed_at) values
      (${workspaceId},'t-country-1','c1','canonical','country','string','"BR"'::jsonb,'test',now()),
      (${workspaceId},'t-country-2','c2','canonical','country','string','"BR"'::jsonb,'test',now()),
      (${workspaceId},'t-country-3','c3','canonical','country','string','"US"'::jsonb,'test',now()),
      (${workspaceId},'t-country-4','c4','canonical','country','string','"BR"'::jsonb,'test',now()),
      (${workspaceId},'t-bool-1','c1','canonical','subscribed','boolean','true'::jsonb,'test',now()),
      (${workspaceId},'t-bool-2','c2','canonical','subscribed','boolean','false'::jsonb,'test',now()),
      (${workspaceId},'t-bool-3','c3','canonical','subscribed','boolean','true'::jsonb,'test',now()),
      (${workspaceId},'t-number-1','c1','canonical','score','number','5'::jsonb,'test',now()),
      (${workspaceId},'t-number-2','c2','canonical','score','number','7'::jsonb,'test',now()),
      (${workspaceId},'t-number-3','c3','canonical','score','number','5'::jsonb,'test',now())`);
    await db.execute(sql`insert into customer_outcomes (workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,source_namespace,observed_at) values
      (${workspaceId},'o1','c1','purchase','canonical','purchase','d1','e1','test',now() - interval '30 days'),
      (${workspaceId},'o1-repeat-2','c1','purchase','canonical','purchase','d1-2','e1-2','test',now() - interval '20 days'),
      (${workspaceId},'o1-repeat-3','c1','purchase','canonical','purchase','d1-3','e1-3','test',now() - interval '10 days'),
      (${workspaceId},'o3','c3','purchase','canonical','purchase','d3','e3','test',now() - interval '5 days'),
      (${workspaceId},'o4-private','c4','purchase','canonical','purchase','d4','e4','test',now())`);
  }
  await db.execute(sql`insert into connector_connections (workspace_id,id,provider,role,display_name,lifecycle_state,credential_status,capabilities) values
    (${WORKSPACE_A},'dest-disconnected','test','destination','Disconnected destination','disconnected','valid','["activation"]'::jsonb),
    (${WORKSPACE_A},'dest-healthy','test','destination','Healthy destination','healthy','valid','["activation"]'::jsonb),
    (${WORKSPACE_A},'source-only','test','source','Source only','healthy','valid','["read"]'::jsonb),
    (${WORKSPACE_A},'wrong-capability','test','destination','Read only destination','healthy','valid','["read"]'::jsonb),
    (${WORKSPACE_B},'dest-b-only','test','destination','Workspace B destination','healthy','valid','["activation"]'::jsonb)`);
}

async function resetFixture() {
  await deleteFixture();
  await seedFixture();
  process.env.RADAR_MIN_LABELED_EXAMPLES = '3';
  process.env.RADAR_MIN_POSITIVES = '2';
  process.env.RADAR_MIN_NEGATIVES = '1';
}

async function createRadar(radarService: RadarService, name: string, audienceAst: AudienceAst = { version: 1, op: 'identified' }, destination?: { connectionId: string; capability: 'activation' }) {
  return radarService.create(WORKSPACE_A, {
    name,
    outcomeDefinitionId: 'purchase',
    audienceAst,
    predictionWindowDays: 30,
    activationDestination: destination,
  }) as Promise<RadarView>;
}

describe('Radar Postgres runtime closure', { concurrency: 1 }, () => {
  before(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for Radar runtime test');
    db = createDb();
    await db.execute(sql`insert into workspaces (id,name,slug) values
      (${WORKSPACE_A},'Radar Runtime A','radar-runtime-a'),
      (${WORKSPACE_B},'Radar Runtime B','radar-runtime-b')
      on conflict (id) do update set name=excluded.name`);
  });

  beforeEach(resetFixture);

  after(async () => {
    if (!db) return;
    try {
      await deleteFixture();
      await db.execute(sql`delete from workspaces where id in (${WORKSPACE_A},${WORKSPACE_B})`);
    } finally {
      await closeDb(db);
    }
  });

  test('persisted audience ASTs produce exact deterministic, typed and privacy-safe counts', async () => {
    const radarService = service();
    const cases: Array<[string, AudienceAst, number]> = [
      ['identified', { version: 1, op: 'identified' }, 3],
      ['country-br', { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }, 2],
      ['purchase', { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'purchase' }, 2],
      ['and', { version: 1, op: 'and', children: [{ version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }, { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'purchase' }] }, 1],
      ['or', { version: 1, op: 'or', children: [{ version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }, { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'purchase' }] }, 3],
    ];
    for (const [name, ast, expected] of cases) {
      const persisted = await createRadar(radarService, `Audience ${name}`, ast);
      assert.equal(typeof persisted.definition.audience_ast, 'object');
      assert.equal(await radarService.audienceCount(WORKSPACE_A, persisted.definition.audience_ast), expected);
      assert.equal(await radarService.audienceCount(WORKSPACE_A, persisted.definition.audience_ast), expected);
    }

    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'subscribed', operator: 'eq', value: true }), 2);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'score', operator: 'eq', value: 5 }), 2);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'missing', operator: 'exists' }), 0);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'US' }), 1);
    await db.execute(sql`update customer_traits set value='"BR"'::jsonb,observed_at=now() where workspace_id=${WORKSPACE_A} and customer_id='c3' and trait_namespace='canonical' and trait_key='country'`);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }), 3);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'US' }), 0);

    await db.execute(sql`update customers set deleted_at=now() where workspace_id=${WORKSPACE_A} and id='c2'`);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }), 2);
    assert.equal(await radarService.audienceCount(WORKSPACE_A, { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'purchase' }), 2);
    assert.equal(await radarService.audienceCount(WORKSPACE_B, { version: 1, op: 'identified' }), 3);

    const malformed = await createRadar(radarService, 'Malformed persisted JSON');
    await db.execute(sql`update radar_definition_versions set audience_ast=to_jsonb('not-json'::text) where workspace_id=${WORKSPACE_A} and radar_id=${malformed.radar.id}`);
    await assert.rejects(() => radarService.get(WORKSPACE_A, malformed.radar.id), /Persisted Radar audience definition is invalid/);
    const [customersStillExist] = await db.execute(sql`select count(*)::int as count from customers where workspace_id=${WORKSPACE_A}`);
    assert.equal(Number((customersStillExist as { count: number }).count), 4);
  });

  test('activation destination is workspace/capability safe, warning-only when disconnected, and versioned', async () => {
    const radarService = service();
    const created = await createRadar(radarService, 'Destination radar', { version: 1, op: 'identified' }, { connectionId: 'dest-disconnected', capability: 'activation' });
    assert.deepEqual(created.definition.activation_destination, { connectionId: 'dest-disconnected', capability: 'activation' });
    assert.deepEqual(created.activationReadiness, { status: 'unavailable', reasonCode: 'activation_destination_unavailable' });
    const readiness = await radarService.validate(WORKSPACE_A, created.radar.id);
    assert.equal(readiness.status, 'ready_to_train');
    assert.deepEqual(readiness.warnings, ['activation_destination_unavailable']);

    await assert.rejects(() => createRadar(radarService, 'Cross workspace', undefined, { connectionId: 'dest-b-only', capability: 'activation' }), /compatible workspace connection/);
    await assert.rejects(() => createRadar(radarService, 'Wrong role', undefined, { connectionId: 'source-only', capability: 'activation' }), /compatible workspace connection/);
    await assert.rejects(() => createRadar(radarService, 'Wrong capability', undefined, { connectionId: 'wrong-capability', capability: 'activation' }), /compatible workspace connection/);

    const changed = await radarService.patch(WORKSPACE_A, created.radar.id, { activationDestination: { connectionId: 'dest-healthy', capability: 'activation' } }) as RadarView;
    assert.equal(changed.radar.current_definition_version, 2);
    assert.deepEqual(changed.definition.activation_destination, { connectionId: 'dest-healthy', capability: 'activation' });
    assert.equal(changed.activationReadiness.status, 'ready');
    await db.execute(sql`delete from connector_connections where workspace_id=${WORKSPACE_A} and id='dest-healthy'`);
    const missing = await radarService.get(WORKSPACE_A, created.radar.id) as RadarView;
    assert.deepEqual(missing.definition.activation_destination, { connectionId: 'dest-healthy', capability: 'activation' });
    assert.deepEqual(missing.activationReadiness, { status: 'unavailable', reasonCode: 'activation_destination_unavailable' });
  });

  test('readiness uses the current audience, unique customers, history, warnings, blockers and recovery', async () => {
    const radarService = service();
    const beforeRows = await db.execute(sql`select id,status,deleted_at from customers where workspace_id=${WORKSPACE_A} order by id`);
    const created = await createRadar(radarService, 'Ready radar');
    assert.equal(created.radar.status, 'draft');
    const ready = await radarService.validate(WORKSPACE_A, created.radar.id);
    assert.equal(ready.status, 'ready_to_train');
    assert.equal(ready.eligibleCustomerCount, 3);
    assert.equal(ready.positiveOutcomeCount, 2);
    assert.equal(ready.negativeCount, 1);
    assert.ok(ready.historyDays >= 89);
    assert.equal(ready.quality.identityCoverage, 1);
    assert.deepEqual(ready.quality.contextCoverage, { score: 100 });
    assert.deepEqual(ready.reasonCodes, []);
    const afterRows = await db.execute(sql`select id,status,deleted_at from customers where workspace_id=${WORKSPACE_A} order by id`);
    assert.deepEqual(afterRows, beforeRows);

    process.env.RADAR_MIN_POSITIVES = '3';
    const insufficient = await createRadar(radarService, 'Recovery radar');
    const blocked = await radarService.validate(WORKSPACE_A, insufficient.radar.id);
    assert.equal(blocked.status, 'insufficient_data');
    assert.deepEqual(blocked.reasonCodes, ['insufficient_positive_outcomes']);
    process.env.RADAR_MIN_POSITIVES = '2';
    const recovered = await radarService.validate(WORKSPACE_A, insufficient.radar.id);
    assert.equal(recovered.status, 'ready_to_train');

    process.env.RADAR_MIN_LABELED_EXAMPLES = '2';
    process.env.RADAR_MIN_POSITIVES = '1';
    const br = await createRadar(radarService, 'BR readiness', { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' });
    const brReady = await radarService.validate(WORKSPACE_A, br.radar.id);
    assert.equal(brReady.eligibleCustomerCount, 2);
    assert.equal(brReady.positiveOutcomeCount, 1);
    assert.equal(brReady.negativeCount, 1);
    assert.equal(brReady.status, 'ready_to_train');

    const warningService = service({ criticalCount: 0, warningsCount: 1 });
    const warningRadar = await createRadar(warningService, 'Warning radar');
    const warning = await warningService.validate(WORKSPACE_A, warningRadar.radar.id);
    assert.equal(warning.status, 'ready_to_train');
    assert.deepEqual(warning.warnings, ['quality_warnings']);

    const blockerService = service({ criticalCount: 1, warningsCount: 0, radarReadiness: { reasonCodes: ['blocking_quality_issues'] } });
    const blockerRadar = await createRadar(blockerService, 'Blocker radar');
    const qualityBlocked = await blockerService.validate(WORKSPACE_A, blockerRadar.radar.id);
    assert.equal(qualityBlocked.status, 'insufficient_data');
    assert.ok(qualityBlocked.reasonCodes.includes('blocking_quality_issues'));

    process.env.RADAR_MIN_LABELED_EXAMPLES = '3';
    process.env.RADAR_MIN_POSITIVES = '2';
    process.env.RADAR_MIN_NEGATIVES = '2';
    const negativeRadar = await createRadar(radarService, 'Insufficient negatives');
    const negativeBlocked = await radarService.validate(WORKSPACE_A, negativeRadar.radar.id);
    assert.equal(negativeBlocked.negativeCount, 1);
    assert.deepEqual(negativeBlocked.reasonCodes, ['insufficient_negative_examples']);

    process.env.RADAR_MIN_NEGATIVES = '1';
    await db.execute(sql`update customers set first_seen_at=now() - interval '5 days' where workspace_id=${WORKSPACE_A}`);
    const historyRadar = await createRadar(radarService, 'Insufficient history');
    const historyBlocked = await radarService.validate(WORKSPACE_A, historyRadar.radar.id);
    assert.equal(historyBlocked.historyDays, 5);
    assert.ok(historyBlocked.reasonCodes.includes('insufficient_history'));

    await db.execute(sql`update customers set status='anonymous' where workspace_id=${WORKSPACE_A} and id in ('c1','c2','c3')`);
    process.env.RADAR_MIN_LABELED_EXAMPLES = '1';
    process.env.RADAR_MIN_POSITIVES = '1';
    const anonymousRadar = await createRadar(radarService, 'Anonymous only');
    const anonymousBlocked = await radarService.validate(WORKSPACE_A, anonymousRadar.radar.id);
    assert.equal(anonymousBlocked.eligibleCustomerCount, 0);
    assert.equal(anonymousBlocked.status, 'insufficient_data');
    assert.ok(anonymousBlocked.reasonCodes.includes('insufficient_labeled_examples'));
  });

  test('custom target identity survives rename and disabled targets fail readiness explicitly', async () => {
    const radarService = service();
    await db.execute(sql`insert into outcome_definitions (workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values (${WORKSPACE_A},'custom-renewal','canonical','custom_renewal','Custom renewal','event','{}'::jsonb,'test')`);
    await db.execute(sql`insert into customer_outcomes (workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,source_namespace,observed_at) values
      (${WORKSPACE_A},'custom-o1','c1','custom-renewal','canonical','custom_renewal','custom-d1','custom-e1','test',now()),
      (${WORKSPACE_A},'custom-o3','c3','custom-renewal','canonical','custom_renewal','custom-d3','custom-e3','test',now())`);
    const metadata = await radarService.availableOutcomes(WORKSPACE_A) as unknown as { id: string; name: string }[];
    assert.ok(metadata.some((outcome) => outcome.id === 'custom-renewal'));
    const created = await radarService.create(WORKSPACE_A, { name: 'Custom target radar', outcomeDefinitionId: 'custom-renewal', predictionWindowDays: 30 }) as RadarView;
    assert.equal((await radarService.validate(WORKSPACE_A, created.radar.id)).status, 'ready_to_train');
    await db.execute(sql`update outcome_definitions set name='Renewal display renamed' where workspace_id=${WORKSPACE_A} and id='custom-renewal'`);
    const renamedMetadata = await radarService.availableOutcomes(WORKSPACE_A) as unknown as { id: string; name: string }[];
    assert.ok(renamedMetadata.some((outcome) => outcome.id === 'custom-renewal' && outcome.name === 'Renewal display renamed'));
    assert.equal(((await radarService.get(WORKSPACE_A, created.radar.id)) as RadarView).definition.version, 1);
    assert.equal((await radarService.validate(WORKSPACE_A, created.radar.id)).status, 'ready_to_train');
    await db.execute(sql`update outcome_definitions set is_active=false where workspace_id=${WORKSPACE_A} and id='custom-renewal'`);
    const disabled = await radarService.validate(WORKSPACE_A, created.radar.id);
    assert.equal(disabled.status, 'insufficient_data');
    assert.ok(disabled.reasonCodes.includes('target_outcome_unavailable'));
    await assert.rejects(() => radarService.train(WORKSPACE_A, created.radar.id, 'disabled-target'), /not ready to train/);
  });

  test('lifecycle success, concurrent train replay, cosmetic rename, pause and archive are durable', async () => {
    const radarService = service();
    const created = await createRadar(radarService, 'Lifecycle success');
    assert.equal(created.radar.status, 'draft');
    assert.equal((await radarService.validate(WORKSPACE_A, created.radar.id)).status, 'ready_to_train');
    const requests = await Promise.all(Array.from({ length: 12 }, (_, index) => radarService.train(WORKSPACE_A, created.radar.id, `key-${index}`)));
    assert.equal(new Set(requests.map((request) => (request as { id: string }).id)).size, 1);
    const request = requests[0] as { id: string; definition_version: number };
    const [requestCount] = await db.execute(sql`select count(*)::int as count from radar_training_requests where workspace_id=${WORKSPACE_A} and radar_id=${created.radar.id} and definition_version=1`);
    assert.equal(Number((requestCount as { count: number }).count), 1);
    const verifiedModel = 'model-test-radar-123-v1';
    await db.execute(sql`insert into radar_model_versions (workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_provider,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,serialization_format,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values (${WORKSPACE_A},${verifiedModel},${created.radar.id},1,${request.id},'purchase',30,'candidate','logistic_regression','propensity-v1','supabase_storage','models','safe/model.joblib','supabase://models/safe/model.joblib','0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','joblib-v1','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'baseline_selected',now())`);
    await db.execute(sql`insert into radar_score_batches (workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values (${WORKSPACE_A},${created.radar.id},1,${verifiedModel},date_trunc('minute',now()),'completed',0,now())`);
    await radarService.reportTrainingResult(WORKSPACE_A, created.radar.id, request.definition_version, request.id, { status: 'succeeded', modelReference: verifiedModel });
    await radarService.reportTrainingResult(WORKSPACE_A, created.radar.id, request.definition_version, request.id, { status: 'succeeded', modelReference: verifiedModel });
    await assert.rejects(() => radarService.reportTrainingResult(WORKSPACE_A, created.radar.id, request.definition_version, request.id, { status: 'failed', failureCategory: 'worker_error' }), /conflicts with an already accepted result/);
    const active = await radarService.get(WORKSPACE_A, created.radar.id) as RadarView;
    assert.equal(active.radar.status, 'active');
    assert.equal(active.radar.current_model_reference, 'model-test-radar-123-v1');
    const retraining = await radarService.train(WORKSPACE_A, created.radar.id, 'retraining-after-healthy') as { id: string };
    assert.notEqual(retraining.id, request.id);
    await radarService.reportTrainingResult(WORKSPACE_A, created.radar.id, 1, retraining.id, { status: 'failed', failureCategory: 'artifact_error', failureReason: 'readback failed' });
    const afterFailedRetraining = await radarService.get(WORKSPACE_A, created.radar.id) as RadarView;
    assert.equal(afterFailedRetraining.radar.status, 'active');
    assert.equal(afterFailedRetraining.radar.current_model_reference, verifiedModel);
    const [preservedScores] = await db.execute(sql`select count(*)::int as count from radar_score_batches where workspace_id=${WORKSPACE_A} and radar_id=${created.radar.id} and model_version_id=${verifiedModel} and status='completed'`);
    assert.equal(Number((preservedScores as { count: number }).count), 1);
    const renamed = await radarService.patch(WORKSPACE_A, created.radar.id, { name: 'Lifecycle renamed' }) as RadarView;
    assert.equal(renamed.radar.current_definition_version, 1);
    assert.equal(renamed.radar.current_model_reference, 'model-test-radar-123-v1');
    await radarService.action(WORKSPACE_A, created.radar.id, 'paused');
    assert.equal(((await radarService.get(WORKSPACE_A, created.radar.id)) as RadarView).radar.status, 'paused');
    await assert.rejects(() => radarService.train(WORKSPACE_A, created.radar.id, 'paused-train'), /Radar is not ready to train/);
    await radarService.action(WORKSPACE_A, created.radar.id, 'archived');
    assert.equal(((await radarService.get(WORKSPACE_A, created.radar.id)) as RadarView).radar.status, 'archived');
    await assert.rejects(() => radarService.train(WORKSPACE_A, created.radar.id, 'archive-train'), /Archived Radar cannot train/);
    const [history] = await db.execute(sql`select (select count(*) from radar_definition_versions where workspace_id=${WORKSPACE_A} and radar_id=${created.radar.id})::int as definitions,(select count(*) from radar_training_requests where workspace_id=${WORKSPACE_A} and radar_id=${created.radar.id})::int as requests`);
    assert.deepEqual({ definitions: Number((history as { definitions: number }).definitions), requests: Number((history as { requests: number }).requests) }, { definitions: 1, requests: 2 });
    await assert.rejects(() => radarService.get(WORKSPACE_B, created.radar.id), /Radar not found/);
    await assert.rejects(() => radarService.reportTrainingResult(WORKSPACE_B, created.radar.id, 1, request.id, { status: 'succeeded', modelReference: 'spoofed' }), /Radar not found/);
  });

  test('failed training is safe/retryable and stale success or failure cannot mutate a newer definition', async () => {
    const radarService = service();
    const failedRadar = await createRadar(radarService, 'Failure radar');
    await radarService.validate(WORKSPACE_A, failedRadar.radar.id);
    const failedRequest = await radarService.train(WORKSPACE_A, failedRadar.radar.id, 'failure-key') as { id: string; definition_version: number };
    await radarService.reportTrainingResult(WORKSPACE_A, failedRadar.radar.id, 1, failedRequest.id, {
      status: 'failed',
      failureCategory: 'worker_error',
      failureReason: 'access_token=super-secret postgresql://user:password@host/database',
    });
    await radarService.reportTrainingResult(WORKSPACE_A, failedRadar.radar.id, 1, failedRequest.id, {
      status: 'failed',
      failureCategory: 'worker_error',
      failureReason: 'duplicate callback may carry a different safe message',
    });
    await assert.rejects(() => radarService.reportTrainingResult(WORKSPACE_A, failedRadar.radar.id, 1, failedRequest.id, { status: 'succeeded', modelReference: 'conflicting-model' }), /conflicts with an already accepted result/);
    const failed = await radarService.get(WORKSPACE_A, failedRadar.radar.id) as RadarView;
    assert.equal(failed.radar.status, 'failed');
    assert.equal(failed.radar.current_model_reference, null);
    const [storedFailure] = await db.execute(sql`select failure_category,failure_reason from radar_training_requests where workspace_id=${WORKSPACE_A} and id=${failedRequest.id}`);
    assert.equal((storedFailure as { failure_category: string }).failure_category, 'worker_error');
    assert.equal((storedFailure as { failure_reason: string }).failure_reason.includes('super-secret'), false);
    assert.equal((storedFailure as { failure_reason: string }).failure_reason.includes('postgresql://'), false);
    assert.equal((await radarService.validate(WORKSPACE_A, failedRadar.radar.id)).status, 'ready_to_train');
    const retried = await radarService.train(WORKSPACE_A, failedRadar.radar.id, 'retry-key') as { id: string; status: string };
    assert.equal(retried.id, failedRequest.id);
    assert.equal(retried.status, 'accepted');

    const staleRadar = await createRadar(radarService, 'Stale radar');
    await radarService.validate(WORKSPACE_A, staleRadar.radar.id);
    const staleRequest = await radarService.train(WORKSPACE_A, staleRadar.radar.id, 'stale-key') as { id: string };
    const changed = await radarService.patch(WORKSPACE_A, staleRadar.radar.id, { predictionWindowDays: 14 }) as RadarView;
    assert.equal(changed.radar.current_definition_version, 2);
    assert.equal(changed.radar.status, 'draft');
    assert.equal(changed.radar.current_model_reference, null);
    await assert.rejects(() => radarService.reportTrainingResult(WORKSPACE_A, staleRadar.radar.id, 1, staleRequest.id, { status: 'succeeded', modelReference: 'late-success' }), /Stale training result/);
    await assert.rejects(() => radarService.reportTrainingResult(WORKSPACE_A, staleRadar.radar.id, 1, staleRequest.id, { status: 'failed', failureReason: 'late-failure' }), /Stale training result/);
    const afterLate = await radarService.get(WORKSPACE_A, staleRadar.radar.id) as RadarView;
    assert.equal(afterLate.radar.status, 'draft');
    assert.equal(afterLate.radar.current_model_reference, null);
    await db.execute(sql`update radars set status='ready_to_train' where workspace_id=${WORKSPACE_A} and id=${staleRadar.radar.id}`);
    await assert.rejects(() => radarService.train(WORKSPACE_A, staleRadar.radar.id, 'v2-with-stale-readiness'), /no valid readiness approval/);

    const racedRadar = await createRadar(radarService, 'Result edit race');
    await radarService.validate(WORKSPACE_A, racedRadar.radar.id);
    const racedRequest = await radarService.train(WORKSPACE_A, racedRadar.radar.id, 'race-key') as { id: string };
    const race = await Promise.allSettled([
      radarService.reportTrainingResult(WORKSPACE_A, racedRadar.radar.id, 1, racedRequest.id, { status: 'succeeded', modelReference: 'raced-model' }),
      radarService.patch(WORKSPACE_A, racedRadar.radar.id, { predictionWindowDays: 14 }),
    ]);
    assert.ok(race.some((result) => result.status === 'fulfilled'));
    const afterRace = await radarService.get(WORKSPACE_A, racedRadar.radar.id) as RadarView;
    assert.equal(afterRace.radar.current_definition_version, 2);
    assert.equal(afterRace.radar.status, 'draft');
    assert.equal(afterRace.radar.current_model_reference, null);
  });

  test('prediction windows and illegal lifecycle operations fail closed', async () => {
    const radarService = service();
    for (const predictionWindowDays of [7, 14, 30, 60]) {
      const radar = await radarService.create(WORKSPACE_A, { name: `Window ${predictionWindowDays}`, outcomeDefinitionId: 'purchase', predictionWindowDays }) as RadarView;
      assert.equal(radar.definition.prediction_window_days, predictionWindowDays);
    }
    for (const predictionWindowDays of [0, -7, 1, 365, 7.5, '30']) {
      await assert.rejects(() => radarService.create(WORKSPACE_A, { name: `Invalid ${predictionWindowDays}`, outcomeDefinitionId: 'purchase', predictionWindowDays: predictionWindowDays as number }), /Prediction window/);
    }
    const draft = await createRadar(radarService, 'Illegal transitions');
    await assert.rejects(() => radarService.action(WORKSPACE_A, draft.radar.id, 'paused'), /Illegal Radar transition: draft -> paused/);
    await radarService.action(WORKSPACE_A, draft.radar.id, 'archived');
    await assert.rejects(() => radarService.validate(WORKSPACE_A, draft.radar.id), /Illegal Radar transition: archived -> validating_data/);
    await assert.rejects(() => radarService.patch(WORKSPACE_A, draft.radar.id, { predictionWindowDays: 14 }), /Archived Radar cannot be changed/);
  });

  test('Postgres catalog contains Radar ownership/version/training uniqueness constraints', async () => {
    const indexes = await db.execute(sql`select indexname from pg_indexes where schemaname='public' and tablename in ('radars','radar_definition_versions','radar_training_requests')`);
    const names = new Set((indexes as unknown as { indexname: string }[]).map((row) => row.indexname));
    assert.ok(names.has('radars_workspace_id_id_pk'));
    assert.ok(names.has('radars_ws_name_uq'));
    assert.ok(names.has('radar_definition_versions_workspace_id_radar_id_version_pk'));
    assert.ok(names.has('radar_training_requests_workspace_id_id_pk'));
    assert.ok(names.has('radar_training_requests_idempotency_uq'));
    assert.ok(names.has('radar_training_requests_claimable_idx'));
    assert.equal(names.has('radar_training_requests_one_per_definition_uq'), false);
    const foreignKeys = await db.execute(sql`select conname from pg_constraint where contype='f' and conrelid in ('radar_definition_versions'::regclass,'radar_training_requests'::regclass)`);
    const foreignKeyNames = new Set((foreignKeys as unknown as { conname: string }[]).map((row) => row.conname));
    assert.ok(foreignKeyNames.has('radar_definition_versions_radar_fk'));
    assert.ok(foreignKeyNames.has('radar_training_requests_definition_fk'));
  });
});
