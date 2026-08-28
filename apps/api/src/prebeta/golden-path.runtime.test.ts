import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '@truvo/db';
import { structuredLog } from '@truvo/observability';
import { SupabaseAuthGuard } from '../modules/auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../modules/auth/guards/workspace.guard';
import { AuditService } from '../modules/audit/audit.service';
import { ConnectorConnectionService } from '../modules/connectors/connector-connection.service';
import { ConnectorDestinationService } from '../modules/connectors/connector-destination.service';
import { ConnectorRegistryService } from '../modules/connectors/connector-registry.service';
import { ConnectorSyncOrchestratorService } from '../modules/connectors/connector-sync-orchestrator.service';
import { CanonicalMappingService } from '../modules/connectors/canonical-mapping';
import { BillingContextWriteService } from '../modules/connectors/billing/billing-context-write.service';
import { CommerceWriteService } from '../modules/connectors/commerce/commerce-write.service';
import { CrmWriteService } from '../modules/connectors/crm/crm-write.service';
import { EngagementWriteService } from '../modules/connectors/engagement/engagement-write.service';
import { createFakeDestinationAdapter, createFakeProviderState, createFakeSourceAdapter, FAKE_PROVIDER } from '../modules/connectors/testing/fake-provider.adapter';
import { CustomerContextService } from '../modules/customer-context/customer-context.service';
import { SuppressionService } from '../modules/customer-context/suppression.service';
import { DataLifecycleService } from '../modules/data-lifecycle/data-lifecycle.service';
import { closeClickHouse } from '../modules/data-lifecycle/erasure/clickhouse.infra';
import { DecisionsService } from '../modules/decisions/decisions.service';
import { IdentityGraphService } from '../modules/identity/identity-graph.service';
import { OpportunitiesService } from '../modules/opportunities/opportunities.service';
import { ModelRegistryService } from '../modules/radars/model-registry.service';

const stamp = `${Date.now()}_${process.pid}`;
const workspaceA = '33333333-3333-4333-8333-333333333333';
const workspaceB = '44444444-4444-4444-8444-444444444444';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jwtSecret = `golden-path-secret-${stamp}`;

function token(workspaceUser: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: workspaceUser, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300, iss: 'https://golden.auth.local/auth/v1' })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')}`;
}
function executionContext(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => (() => undefined), getClass: () => class GoldenPath {} } as unknown as ExecutionContext;
}

test('Phase I: authenticated connector→context→model→opportunity→decision→exposure→reward→erasure golden path', async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = `golden-encryption-${stamp}`;
  process.env.SUPABASE_JWT_SECRET = jwtSecret;
  process.env.SUPABASE_URL = 'https://golden.auth.local';
  const db = createDb();
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const context = new CustomerContextService(db, suppression);
  const identity = new IdentityGraphService(db, context, suppression);
  const decisions = new DecisionsService(db, audit);
  const engagement = new EngagementWriteService(db, context, decisions);
  const registry = new ConnectorRegistryService();
  const state = createFakeProviderState();
  registry.registerSource(createFakeSourceAdapter(state));
  registry.registerDestination(createFakeDestinationAdapter(state));
  const connections = new ConnectorConnectionService(db, audit, registry);
  const mapping = new CanonicalMappingService(identity, context, new CommerceWriteService(db, context), new BillingContextWriteService(db, context), new CrmWriteService(db), engagement);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const opportunities = new OpportunitiesService(db, audit, connections, registry, destination, decisions);
  const lifecycle = new DataLifecycleService(db, context, audit, suppression);
  const artifacts = { verify: async () => ({ ok: true }) };
  const models = new ModelRegistryService(db, audit, artifacts as never);
  try {
    await db.execute(sql`insert into users(id,email) values(${userId},'golden-operator@example.invalid')`);
    await db.execute(sql`insert into workspaces(id,name,slug,created_by) values
      (${workspaceA},'Golden A',${`golden-a-${stamp}`},${userId}),(${workspaceB},'Golden B',${`golden-b-${stamp}`},${userId})`);
    await db.execute(sql`insert into workspace_members(workspace_id,user_id,role,status) values(${workspaceA},${userId},'owner','active')`);
    const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token(userId)}`, 'x-workspace-id': workspaceA } };
    const auth = new SupabaseAuthGuard({ auth: { getUser: async () => { throw new Error('unexpected remote auth'); } } } as never);
    assert.equal(await auth.canActivate(executionContext(request)), true);
    assert.equal(await new WorkspaceGuard(db, new Reflector()).canActivate(executionContext(request)), true);

    const createConnection = async (workspaceId: string, label: string) => {
      const connection = await connections.create(workspaceId, { provider: FAKE_PROVIDER, role: 'bidirectional', displayName: label, capabilities: ['initial_backfill', 'outbound_audience'] }, { id: userId });
      await connections.setCredentials(workspaceId, connection.id, { api_key: state.validApiKey }, { id: userId });
      assert.equal((await connections.testConnection(workspaceId, connection.id, { id: userId })).ok, true);
      return connection;
    };
    state.catalog = [{ identifiers: [{ providerNamespace: FAKE_PROVIDER, identifierType: 'external_id', identifierValue: 'overlapping-looking-id' }], traits: [{ traitNamespace: 'feature', traitKey: 'segment', valueType: 'string', value: 'prebeta' }], observedAt: new Date().toISOString() }];
    const connectionA = await createConnection(workspaceA, 'Golden deterministic A');
    assert.equal((await orchestrator.runBackfill(workspaceA, connectionA.id)).status, 'succeeded');
    const [customerA] = await db.execute(sql`select customer_id from customer_identifiers where workspace_id=${workspaceA} and provider_namespace=${FAKE_PROVIDER} and identifier_value='overlapping-looking-id'`) as Array<{ customer_id: string }>;
    assert.ok(customerA?.customer_id);

    state.catalog = [{ identifiers: [{ providerNamespace: FAKE_PROVIDER, identifierType: 'external_id', identifierValue: 'overlapping-looking-id' }], traits: [{ traitNamespace: 'feature', traitKey: 'segment', valueType: 'string', value: 'other' }], observedAt: new Date().toISOString() }];
    const connectionB = await createConnection(workspaceB, 'Golden deterministic B');
    assert.equal((await orchestrator.runBackfill(workspaceB, connectionB.id)).status, 'succeeded');
    const [customerB] = await db.execute(sql`select customer_id from customer_identifiers where workspace_id=${workspaceB} and provider_namespace=${FAKE_PROVIDER} and identifier_value='overlapping-looking-id'`) as Array<{ customer_id: string }>;
    assert.ok(customerB?.customer_id);
    assert.notEqual(customerA.customer_id, customerB.customer_id);

    const radarId = `rad_golden_${stamp}`;
    const requestId = `rtr_golden_${stamp}`;
    const modelId = `mdl_golden_${stamp}`;
    const scoreCutoff = new Date(Date.now() - 86_400_000);
    await db.execute(sql`insert into outcome_definitions(workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace)
      values(${workspaceA},'purchase','canonical','purchase','Purchase','event','{"event_name":"purchase"}'::jsonb,'golden')`);
    await db.execute(sql`insert into radars(workspace_id,id,name,status,current_definition_version) values(${workspaceA},${radarId},'Golden Radar','ready_to_train',1)`);
    await db.execute(sql`insert into radar_definition_versions(workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,activation_destination,readiness)
      values(${workspaceA},${radarId},1,'purchase','{"version":1,"op":"identified"}'::jsonb,30,'{}'::jsonb,${JSON.stringify({ connectionId: connectionA.id, capability: 'outbound_audience' })}::jsonb,'{}'::jsonb)`);
    await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id)
      values(${workspaceA},${requestId},${radarId},1,'golden-training','succeeded','golden-training-correlation')`);
    await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_provider,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at)
      values(${workspaceA},${modelId},${radarId},1,${requestId},'purchase',30,'validated','logistic_regression','propensity-v1','supabase_storage','models',${`workspaces/${workspaceA}/radars/${radarId}/model.joblib`},${`supabase://models/workspaces/${workspaceA}/radars/${radarId}/model.joblib`},${'a'.repeat(64)},'{}','{}','{}','{}','golden-private-artifact',now())`);
    assert.deepEqual(await models.promote(workspaceA, radarId, modelId, userId, 'golden-path-explicit-promotion'), { modelId, status: 'active' });
    await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at)
      values(${workspaceA},${radarId},1,${modelId},${scoreCutoff.toISOString()}::timestamptz,'completed',1,now())`);
    await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at)
      values(${workspaceA},${radarId},1,${modelId},${customerA.customer_id},${scoreCutoff.toISOString()}::timestamptz,.91,'propensity-v1','["golden_signal"]',now())`);

    const batch = await opportunities.materialize(workspaceA, radarId, 'golden-path');
    const page = await opportunities.list(workspaceA, radarId, { sort: 'probability', limit: 10 });
    assert.equal(page.items.length, 1);
    const activation = await opportunities.activate(workspaceA, userId, { radarId, selection: { mode: 'selected', batchId: batch.id, ids: [page.items[0]!.id] }, correlationId: `corr_golden_${stamp}`, connectionId: connectionA.id, idempotencyKey: `activation_golden_${stamp}` });
    assert.equal(activation.status, 'success');
    assert.equal(activation.decisionCount, 1);
    const [ledger] = await db.execute(sql`select d.id decision_id,e.id execution_id,e.remote_id from decision_records d join action_executions e on e.workspace_id=d.workspace_id and e.decision_id=d.id where d.workspace_id=${workspaceA} and d.decision_batch_id=${activation.decisionBatchId}`) as Array<{ decision_id: string; execution_id: string; remote_id: string }>;
    assert.ok(ledger?.decision_id && ledger.execution_id && ledger.remote_id);
    const providerEventId = `delivery_golden_${stamp}`;
    await engagement.upsertEvent(workspaceA, connectionA.id, customerA.customer_id, { providerNamespace: FAKE_PROVIDER, providerEventId, metricName: 'Delivered', engagementKind: 'delivery', campaignId: ledger.remote_id, correlationId: `corr_golden_${stamp}`, occurredAt: new Date().toISOString() });
    const [exposure] = await db.execute(sql`select id from exposure_observations where workspace_id=${workspaceA} and decision_id=${ledger.decision_id} and provider_event_id=${providerEventId}`) as Array<{ id: string }>;
    assert.ok(exposure?.id);

    const outcomeId = `out_golden_${stamp}`;
    await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,provenance,observed_at)
      values(${workspaceA},${outcomeId},${customerA.customer_id},'purchase','canonical','purchase',${`order_golden_${stamp}`},${`event_golden_${stamp}`},199.90,'BRL','golden','{"target":"purchase"}',(select created_at from decision_records where workspace_id=${workspaceA} and id=${ledger.decision_id}))`);
    await db.execute(sql`update decision_records set reward_window_end=greatest(created_at+interval '1 microsecond',now()-interval '1 millisecond') where workspace_id=${workspaceA} and id=${ledger.decision_id}`);
    await decisions.reconcileDecision(workspaceA, ledger.decision_id);
    const [reward] = await db.execute(sql`select id,outcome_count,observed_value,final from reward_observations where workspace_id=${workspaceA} and decision_id=${ledger.decision_id} order by version desc limit 1`) as Array<{ id: string; outcome_count: number; observed_value: string; final: boolean }>;
    assert.deepEqual({ count: reward.outcome_count, value: reward.observed_value, final: reward.final }, { count: 1, value: '199.90', final: true });

    const erasure = await lifecycle.requestSubjectDeletion(workspaceA, customerA.customer_id, { id: userId });
    assert.equal(erasure.status, 'completed', JSON.stringify(erasure.stores));
    const learning = await decisions.learningRows(workspaceA, { limit: 10 });
    const privacySafe = learning.items.find((row: { decision_id: string }) => row.decision_id === ledger.decision_id);
    assert.equal(privacySafe?.customer_id, null);
    assert.equal(privacySafe?.subject_erased, true);
    assert.equal((await context.getContext(workspaceA, customerA.customer_id)), null);
    assert.ok(await context.getContext(workspaceB, customerB.customer_id));

    const provenance = { workspaceId: workspaceA, customerId: customerA.customer_id, radarId, modelId, scoreBatch: `${radarId}:${modelId}:${scoreCutoff.toISOString()}`, opportunityBatchId: batch.id, activationId: activation.id, decisionId: ledger.decision_id, executionId: ledger.execution_id, exposureId: exposure.id, rewardId: reward.id, erasureRequestId: erasure.requestId };
    assert.ok(Object.values(provenance).every(Boolean));
    structuredLog('info', 'prebeta_golden_path_completed', { ...provenance, customerId: '[REDACTED]', tenantIsolationWorkspace: workspaceB });
  } finally {
    delete process.env.SUPABASE_JWT_SECRET;
    await closeClickHouse().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
