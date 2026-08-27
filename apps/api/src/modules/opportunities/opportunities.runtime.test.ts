import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { ConnectorDestinationService } from '../connectors/connector-destination.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import type { DestinationAdapter, DestinationWriteInput } from '../connectors/contracts';
import { OpportunitiesService } from './opportunities.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { getRedis } from '../events/infra';

const WS = '00000000-0000-0000-0000-000000000100';
const OTHER_WS = '00000000-0000-0000-0000-000000000101';
const RADAR = 'rad_order100';
const MODEL = 'mdl_order100';
const CUTOFF_A = '2026-08-20T12:00:00.000Z';
const CUTOFF_B = '2026-08-21T12:00:00.000Z';

let db: Database;
let opportunities: OpportunitiesService;
let registry: ConnectorRegistryService;
let providerWrites: DestinationWriteInput[];
let failWriteNumber = 0;
let suppressOnFirstWrite: string | null = null;

const adapter: DestinationAdapter = {
  definition: {
    provider: 'order100-test', displayName: 'Order 100 deterministic destination', role: 'destination',
    capabilities: ['outbound_audience'], credentialKind: 'api_key',
  },
  testConnection: async () => ({ ok: true, credentialStatus: 'valid', checks: {}, message: 'ok' }),
  write: async (_connection, _credentials, input) => {
    providerWrites.push(input);
    if (providerWrites.length === 1 && suppressOnFirstWrite) {
      await db.execute(sql`update customers set deleted_at=now() where workspace_id=${WS} and id=${suppressOnFirstWrite}`);
    }
    if (failWriteNumber === providerWrites.length) return { status: 'failed', retryable: true, error: 'test_outage' };
    return { status: 'sent', externalResultId: 'remote-audience-order100' };
  },
};

async function clean() {
  await db.execute(sql`delete from opportunity_activations where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from opportunity_exports where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from connector_destination_writes where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from opportunity_rows where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from opportunity_batches where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_propensity_scores where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_score_batches where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_model_monitoring_snapshots where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_model_versions where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_training_requests where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radar_definition_versions where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from radars where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from customer_outcomes where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from customer_traits where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from customer_identifiers where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from customers where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from outcome_definitions where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from connector_connections where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from audit_log where workspace_id in (${WS},${OTHER_WS})`);
  await db.execute(sql`delete from workspaces where id in (${WS},${OTHER_WS})`);
}

async function seedBase() {
  await db.execute(sql`insert into workspaces(id,name,slug) values (${WS},'Order 100','order-100'),(${OTHER_WS},'Order 100 other','order-100-other')`);
  await db.execute(sql`insert into outcome_definitions(workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values
    (${WS},'purchase','canonical','purchase','Purchase','event','{}'::jsonb,'test'),
    (${OTHER_WS},'purchase','canonical','purchase','Purchase','event','{}'::jsonb,'test')`);
  await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values
    (${WS},'c1','identified','test','2026-01-01','2026-08-19'),
    (${WS},'c2','identified','test','2026-01-01','2026-08-18'),
    (${WS},'c3','identified','test','2026-01-01','2026-08-17'),
    (${WS},'c4','identified','test','2026-01-01','2026-08-16'),
    (${WS},'c5','identified','test','2026-01-01','2026-08-15'),
    (${WS},'c6','identified','test','2026-01-01','2026-08-14'),
    (${WS},'c7','identified','test','2026-01-01','2026-08-13')`);
  await db.execute(sql`insert into customer_identifiers(workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at)
    select ${WS},'id-'||id,id,'external_id','test','dest-'||id,'test','2026-01-01','2026-08-19' from customers where workspace_id=${WS}`);
  let outcomeIndex = 0;
  for (const [customer, values] of [['c1', [125, 125, 125]], ['c2', [10, 11, 12, 13, 1_000_000]]] as const) {
    for (const value of values) {
      outcomeIndex += 1;
      await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at)
        values(${WS},${`out-${outcomeIndex}`},${customer},'purchase','canonical','purchase',${`d-${outcomeIndex}`},${`e-${outcomeIndex}`},${value},'BRL','test','2026-08-01')`);
    }
  }
  for (const [value, currency] of [[20, 'BRL'], [21, 'USD'], [22, 'BRL']] as const) {
    outcomeIndex += 1;
    await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at)
      values(${WS},${`out-${outcomeIndex}`},'c3','purchase','canonical','purchase',${`d-${outcomeIndex}`},${`e-${outcomeIndex}`},${value},${currency},'test','2026-08-01')`);
  }
  await seedRadar(WS, CUTOFF_A);
  await db.execute(sql`insert into connector_connections(workspace_id,id,provider,role,display_name,lifecycle_state,credential_status,capabilities) values
    (${WS},'dest-ready','order100-test','destination','Ready','healthy','valid','["outbound_audience"]'::jsonb),
    (${WS},'dest-off','order100-test','destination','Off','disconnected','valid','["outbound_audience"]'::jsonb),
    (${WS},'dest-wrong','order100-test','destination','Wrong','healthy','valid','["outbound_profile"]'::jsonb),
    (${OTHER_WS},'dest-other','order100-test','destination','Other','healthy','valid','["outbound_audience"]'::jsonb)`);
}

async function seedRadar(workspaceId: string, cutoff: string, customerCount = workspaceId === WS ? 7 : 1) {
  const suffix = workspaceId === WS ? '' : '-other';
  if (workspaceId !== WS) {
    await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values(${workspaceId},'c1','identified','test','2026-01-01','2026-08-19')`);
    await db.execute(sql`insert into customer_identifiers(workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at) values(${workspaceId},'id-c1','c1','external_id','test','other-c1','test','2026-01-01','2026-08-19')`);
  }
  await db.execute(sql`insert into radars(workspace_id,id,name,status,current_definition_version) values(${workspaceId},${RADAR},'Revenue Radar','active',1)`);
  await db.execute(sql`insert into radar_definition_versions(workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,activation_destination,readiness) values
    (${workspaceId},${RADAR},1,'purchase','{"version":1,"op":"identified"}'::jsonb,30,'{}'::jsonb,'{"connectionId":"dest-ready","capability":"activation"}'::jsonb,'{}'::jsonb)`);
  await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values
    (${workspaceId},${`req${suffix}`},${RADAR},1,'initial','succeeded',${`corr${suffix}`})`);
  await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values
    (${workspaceId},${MODEL},${RADAR},1,${`req${suffix}`},'purchase',30,'active','logistic_regression','propensity-v1','models',${`order100${suffix}.joblib`},${`supabase://models/order100${suffix}.joblib`},'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'selected',now())`);
  await db.execute(sql`update radars set current_model_reference=${MODEL} where workspace_id=${workspaceId} and id=${RADAR}`);
  await seedScoreBatch(workspaceId, cutoff, customerCount);
}

async function seedScoreBatch(workspaceId: string, cutoff: string, customerCount: number) {
  await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values
    (${workspaceId},${RADAR},1,${MODEL},${cutoff},'completed',${customerCount},now())`);
  if (customerCount <= 7) {
    const ids = customerCount === 1 ? ['c1'] : Array.from({ length: customerCount }, (_, index) => `c${index + 1}`);
    for (const [index, id] of ids.entries()) {
      const probability = index < 2 ? '0.8' : index < 4 ? '0.7' : '0.5';
      await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at) values
        (${workspaceId},${RADAR},1,${MODEL},${id},${cutoff},${probability},'propensity-v1','["recent_purchase","unknown_future_code"]'::jsonb,${cutoff})`);
    }
  } else {
    await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at)
      select ${workspaceId},${RADAR},1,${MODEL},'scale-'||lpad(g::text,5,'0'),${cutoff},
        ((g % 101)::numeric / 100)::numeric,'propensity-v1','["scale_tie"]'::jsonb,${cutoff}
      from generate_series(1,${customerCount}) g`);
  }
}

describe('Order 100 real PostgreSQL runtime', { concurrency: 1 }, () => {
  before(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    db = createDb();
    registry = new ConnectorRegistryService();
    registry.registerDestination(adapter);
    const audit = new AuditService(db);
    const connections = new ConnectorConnectionService(db, audit, registry);
    const destination = new ConnectorDestinationService(db, connections, registry, audit);
    opportunities = new OpportunitiesService(db, audit, connections, registry, destination);
  });
  beforeEach(async () => { await clean(); await seedBase(); providerWrites = []; failWriteNumber = 0; suppressOnFirstWrite = null; });
  after(async () => { await clean(); await closeDb(db); });

  test('atomic current switch, failed switch, concurrent idempotency and corrupt-score quarantine', async () => {
    const first = await opportunities.materialize(WS, RADAR);
    const summaryA = await opportunities.summary(WS, RADAR);
    assert.equal(summaryA.provenance.opportunityBatchId, first.id);
    assert.deepEqual(summaryA.summary.expectedRevenue, { currency: 'BRL', expected_revenue: '109.60000000000000000' });
    assert.equal(summaryA.summary.monetaryCoverageRatio, 2 / 7);

    await seedScoreBatch(WS, CUTOFF_B, 7);
    let entered!: () => void; let release!: () => void;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
    const continueCommit = new Promise<void>((resolve) => { release = resolve; });
    const building = opportunities.materialize(WS, RADAR, 'atomicity_test', { beforePromotion: async () => { entered(); await continueCommit; } });
    await atBoundary;
    try {
      assert.equal((await opportunities.summary(WS, RADAR)).provenance.opportunityBatchId, first.id);
    } finally {
      release();
    }
    const second = await building;
    assert.notEqual(second.id, first.id);
    assert.equal((await opportunities.summary(WS, RADAR)).provenance.opportunityBatchId, second.id);

    const cutoffFailure = '2026-08-22T12:00:00.000Z';
    await seedScoreBatch(WS, cutoffFailure, 7);
    await assert.rejects(() => opportunities.materialize(WS, RADAR, 'failure_drill', { failBeforePromotion: true }), /forced_failure/);
    assert.equal((await opportunities.summary(WS, RADAR)).provenance.opportunityBatchId, second.id);
    const [partial] = await db.execute(sql`select count(*)::int count from opportunity_batches where workspace_id=${WS} and score_cutoff=${cutoffFailure}`);
    assert.equal(Number((partial as { count: number }).count), 0);

    const competing = await Promise.all([opportunities.materialize(WS, RADAR, 'replica-a'), opportunities.materialize(WS, RADAR, 'replica-b')]);
    assert.equal(competing[0].id, competing[1].id);
    const [current] = await db.execute(sql`select count(*)::int count from opportunity_batches where workspace_id=${WS} and radar_id=${RADAR} and is_current=1`);
    assert.equal(Number((current as { count: number }).count), 1);

    const corruptCutoff = '2026-08-23T12:00:00.000Z';
    await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values(${WS},${RADAR},1,${MODEL},${corruptCutoff},'completed',1,now())`);
    await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at) values(${WS},${RADAR},1,${MODEL},'c1',${corruptCutoff},'1.01','propensity-v1','[]'::jsonb,${corruptCutoff})`);
    await assert.rejects(() => opportunities.materialize(WS, RADAR), /corrupt_score_batch/);
  });

  test('pre-Order-100 completed scores backfill once without retraining or rescoring', async () => {
    const [before] = await db.execute(sql`
      select
        (select count(*)::int from radar_model_versions where workspace_id=${WS}) as models,
        (select count(*)::int from radar_score_batches where workspace_id=${WS}) as batches,
        (select count(*)::int from radar_propensity_scores where workspace_id=${WS}) as scores
    `) as Array<{ models: number; batches: number; scores: number }>;
    const first = await opportunities.backfillExistingScores(WS, 1);
    assert.deepEqual(first, { discovered: 1, materialized: 1, failed: 0, failures: [] });
    const second = await opportunities.backfillExistingScores(WS, 1);
    assert.deepEqual(second, { discovered: 0, materialized: 0, failed: 0, failures: [] });
    const [afterCounts] = await db.execute(sql`
      select
        (select count(*)::int from radar_model_versions where workspace_id=${WS}) as models,
        (select count(*)::int from radar_score_batches where workspace_id=${WS}) as batches,
        (select count(*)::int from radar_propensity_scores where workspace_id=${WS}) as scores
    `) as Array<{ models: number; batches: number; scores: number }>;
    assert.deepEqual(afterCounts, before);
    assert.equal((await opportunities.reconcile(WS, RADAR)).state, 'ready');
  });

  test('compound cursor has deterministic ties and rejects tamper, stale batch and tenant scope', async () => {
    await opportunities.materialize(WS, RADAR);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 2, cursor });
      seen.push(...page.items.map((row) => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 7); assert.equal(new Set(seen).size, 7);
    const expected = await opportunities.list(WS, RADAR, { sort: 'expectedRevenue', filters: { currency: 'BRL' }, limit: 1 });
    assert.ok(expected.nextCursor);
    await assert.rejects(() => opportunities.list(WS, RADAR, { sort: 'expectedRevenue', filters: { currency: 'BRL' }, cursor: `${expected.nextCursor}x` }), /invalid_cursor/);

    await seedRadar(OTHER_WS, CUTOFF_A, 1);
    await opportunities.materialize(OTHER_WS, RADAR);
    await assert.rejects(() => opportunities.list(OTHER_WS, RADAR, { sort: 'expectedRevenue', filters: { currency: 'BRL' }, cursor: expected.nextCursor! }), /stale_cursor/);
    await seedScoreBatch(WS, CUTOFF_B, 7); await opportunities.materialize(WS, RADAR);
    await assert.rejects(() => opportunities.list(WS, RADAR, { sort: 'expectedRevenue', filters: { currency: 'BRL' }, cursor: expected.nextCursor! }), /stale_cursor/);
  });

  test('export is batch-bound/audited and activation covers preview, replay, partial failure, disconnect and suppression-before-send', async () => {
    const materialized = await opportunities.materialize(WS, RADAR);
    const page = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 7 });
    const selection = { mode: 'selected' as const, batchId: materialized.id, ids: page.items.map((row) => row.id) };
    const exported = await opportunities.exportCsv(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'export-100' });
    assert.equal(exported.rowCount, 7); assert.match(exported.csv, /customer_id,probability/); assert.match(exported.csv, /unknown_future_code/);
    const [audit] = await db.execute(sql`select count(*)::int count from audit_log where workspace_id=${WS} and action='opportunity.exported'`);
    assert.equal(Number((audit as { count: number }).count), 1);
    const preview = await opportunities.previewActivation(WS, { radarId: RADAR, selection, correlationId: 'preview-100', connectionId: 'dest-ready', idempotencyKey: 'activation-100' });
    assert.equal(preview.providerMutation, false); assert.equal(providerWrites.length, 0); assert.equal(preview.counts.deliverable, 7);
    const success = await opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'activation-100', connectionId: 'dest-ready', idempotencyKey: 'activation-100' });
    assert.equal(success.status, 'success'); assert.equal(providerWrites.length, 1);
    const replay = await opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'activation-100', connectionId: 'dest-ready', idempotencyKey: 'activation-100' });
    assert.equal(replay.replay, true); assert.equal(providerWrites.length, 1);
    await assert.rejects(() => opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'off', connectionId: 'dest-off', idempotencyKey: 'off' }), /destination_disconnected/);
    await assert.rejects(() => opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'wrong', connectionId: 'dest-wrong', idempotencyKey: 'wrong' }), /destination_disconnected/);
    await assert.rejects(() => opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection, correlationId: 'cross', connectionId: 'dest-other', idempotencyKey: 'cross' }), /destination_disconnected/);

    // New 102-member snapshot gives two bounded provider writes. The first write
    // suppresses a member of the second chunk; the second then fails transiently.
    const cutoff = '2026-08-24T12:00:00.000Z';
    await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at)
      select ${WS},'bulk-'||lpad(g::text,3,'0'),'identified','test','2026-01-01','2026-08-19' from generate_series(1,102) g`);
    await db.execute(sql`insert into customer_identifiers(workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at)
      select ${WS},'bid-'||lpad(g::text,3,'0'),'bulk-'||lpad(g::text,3,'0'),'external_id','test','bulk-dest-'||g,'test','2026-01-01','2026-08-19' from generate_series(1,102) g`);
    await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values(${WS},${RADAR},1,${MODEL},${cutoff},'completed',102,now())`);
    await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at)
      select ${WS},${RADAR},1,${MODEL},'bulk-'||lpad(g::text,3,'0'),${cutoff},'0.8','propensity-v1','[]'::jsonb,${cutoff} from generate_series(1,102) g`);
    const bulk = await opportunities.materialize(WS, RADAR);
    const bulkPreview = await opportunities.previewActivation(WS, { radarId: RADAR, selection: { mode: 'all_matching', batchId: bulk.id }, correlationId: 'partial-preview', connectionId: 'dest-ready', idempotencyKey: 'partial' });
    providerWrites = []; failWriteNumber = 2; suppressOnFirstWrite = bulkPreview.deliverable.at(-1)!.customer_id;
    const partial = await opportunities.activate(WS, 'actor-100', { radarId: RADAR, selection: { mode: 'all_matching', batchId: bulk.id }, correlationId: 'partial', connectionId: 'dest-ready', idempotencyKey: 'partial' });
    assert.equal(partial.status, 'partial'); assert.equal(partial.counts.accepted, 100); assert.equal(partial.counts.retryableFailures, 1); assert.equal(partial.counts.suppressedAfterPreview, 1);
  });

  test('identity merge and erasure remove actionable rows while preserving history and permit a clean canonical rescore', async () => {
    const historical = await opportunities.materialize(WS, RADAR);
    const before = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 7 });
    const c2 = before.items.find((row) => row.customer_id === 'c2')!;
    const c3 = before.items.find((row) => row.customer_id === 'c3')!;
    await db.execute(sql`update customers set status='merged',merged_into_customer_id='c1',updated_at=now() where workspace_id=${WS} and id='c2'`);
    await db.execute(sql`update customers set deleted_at=now(),updated_at=now() where workspace_id=${WS} and id='c3'`);

    const actionable = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 7 });
    assert.equal(actionable.items.some((row) => row.customer_id === 'c2'), false);
    assert.equal(actionable.items.some((row) => row.customer_id === 'c3'), false);
    assert.equal(actionable.items.filter((row) => row.customer_id === 'c1').length, 1);
    const preview = await opportunities.previewActivation(WS, {
      radarId: RADAR,
      selection: { mode: 'selected', batchId: historical.id, ids: [c2.id, c3.id] },
      correlationId: 'privacy-preview', connectionId: 'dest-ready', idempotencyKey: 'privacy-preview',
    });
    assert.equal(preview.counts.suppressed, 2);
    assert.equal(preview.counts.deliverable, 0);
    const [history] = await db.execute(sql`select count(*)::int count from opportunity_rows where workspace_id=${WS} and batch_id=${historical.id}`);
    assert.equal(Number((history as { count: number }).count), 7);
    const [piiColumns] = await db.execute(sql`
      select count(*)::int count from information_schema.columns
      where table_schema='public' and table_name='opportunity_rows'
        and column_name in ('email','phone','name','identifier_value')
    `);
    assert.equal(Number((piiColumns as { count: number }).count), 0);

    const canonicalCutoff = '2026-08-26T12:00:00.000Z';
    await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values(${WS},${RADAR},1,${MODEL},${canonicalCutoff},'completed',5,now())`);
    await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at)
      select ${WS},${RADAR},1,${MODEL},id,${canonicalCutoff},case when id='c1' then 0.9::numeric else 0.6::numeric end,'propensity-v1','[]'::jsonb,${canonicalCutoff}
      from customers where workspace_id=${WS} and id in ('c1','c4','c5','c6','c7')`);
    const canonical = await opportunities.materialize(WS, RADAR);
    const current = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 7 });
    assert.notEqual(canonical.id, historical.id);
    assert.deepEqual(current.items.map((row) => row.customer_id).sort(), ['c1', 'c4', 'c5', 'c6', 'c7']);
    assert.equal(current.items.find((row) => row.customer_id === 'c1')!.probability, '0.9');
  });

  test('10k fixture remains cursor-bounded, tenant-scoped and uses rank indexes', async () => {
    await db.execute(sql`delete from radar_propensity_scores where workspace_id=${WS}`);
    await db.execute(sql`delete from radar_score_batches where workspace_id=${WS}`);
    await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at)
      select ${WS},'scale-'||lpad(g::text,5,'0'),'identified','scale','2026-01-01','2026-08-19' from generate_series(1,10000) g`);
    const cutoff = '2026-08-25T12:00:00.000Z'; await seedScoreBatch(WS, cutoff, 10000);
    const batch = await opportunities.materialize(WS, RADAR);
    assert.equal(batch.rows, 10000);
    const first = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 50 });
    const second = await opportunities.list(WS, RADAR, { sort: 'probability', limit: 50, cursor: first.nextCursor! });
    assert.equal(first.items.length, 50); assert.equal(second.items.length, 50);
    assert.equal(first.items.filter((left) => second.items.some((right) => right.id === left.id)).length, 0);
    const plan = await db.execute(sql`explain (format json) select id from opportunity_rows where workspace_id=${WS} and batch_id=${batch.id} and eligibility_state='eligible' and probability < .9 order by probability desc,id asc limit 50`) as Array<{ 'QUERY PLAN': any }>;
    const serialized = JSON.stringify(plan);
    assert.match(serialized, /opportunity_rows_probability_rank_idx|Index Scan|Bitmap/);
    const [otherCount] = await db.execute(sql`select count(*)::int count from opportunity_rows where workspace_id=${OTHER_WS}`);
    assert.equal(Number((otherCount as { count: number }).count), 0);
  });

  test('existing leader lock elects one Opportunity scheduler replica, isolates workspace failure and Redis is not read truth', async () => {
    await opportunities.materialize(WS, RADAR);
    const redis = getRedis();
    await redis.del('truvo:cron:opportunity-refresh');
    const calls: string[] = [];
    const opportunitySweep = {
      sweepWorkspace: async (workspaceId: string) => {
        calls.push(workspaceId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (workspaceId === OTHER_WS) throw new Error('isolated workspace failure');
      },
    };
    const schedulerDb = { select: () => ({ from: async () => [{ id: WS }, { id: OTHER_WS }] }) } as never;
    const fake = {} as never;
    const make = () => new SchedulerService(schedulerDb, fake, fake, fake, fake, fake, fake, fake, fake, fake, undefined, undefined, opportunitySweep as never);
    const first = make(); const second = make();
    const winners = await Promise.all([first.runOpportunityTick(), second.runOpportunityTick()]);
    assert.deepEqual(winners.sort(), [false, true]);
    assert.deepEqual(calls, [WS, OTHER_WS]);
    assert.equal(await first.runOpportunityTick(), true);
    assert.deepEqual(calls, [WS, OTHER_WS, WS, OTHER_WS]);
    await redis.quit();
    const list = await opportunities.list(WS, RADAR, { limit: 1 });
    assert.equal(list.items.length, 1);
    assert.equal(await second.runOpportunityTick(), false);
  });
});
