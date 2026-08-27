import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { EngagementWriteService } from '../connectors/engagement/engagement-write.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { DataLifecycleService } from '../data-lifecycle/data-lifecycle.service';
import { closeClickHouse } from '../data-lifecycle/erasure/clickhouse.infra';
import { SchedulerService } from '../scheduler/scheduler.service';
import { getRedis } from '../events/infra';
import { DECISION_CREATE_CHUNK_SIZE, DecisionsService } from './decisions.service';

const W = '00000000-0000-0000-0000-000000000110';
const O = '00000000-0000-0000-0000-000000000111';
let db: Database;
let decisions: DecisionsService;

async function seed() {
  await db.execute(sql`insert into workspaces(id,name,slug) values(${W},'Decision','decision'),(${O},'Other','other-decision')`);
  await db.execute(sql`insert into outcome_definitions(workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values(${W},'purchase','canonical','purchase','Purchase','event','{}','test')`);
  await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values(${W},'c1','identified','test',now(),now()),(${W},'c2','identified','test',now(),now()),(${O},'c1','identified','test',now(),now())`);
  await db.execute(sql`insert into connector_connections(workspace_id,id,provider,role,display_name,lifecycle_state,credential_status) values(${W},'dest','klaviyo','bidirectional','Decision connector','healthy','valid'),(${O},'dest','klaviyo','bidirectional','Other connector','healthy','valid')`);
  await db.execute(sql`insert into radars(workspace_id,id,name,status) values(${W},'r1','Radar','active')`);
  await db.execute(sql`insert into radar_definition_versions(workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal) values(${W},'r1',1,'purchase','{}',30,'{}')`);
  await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values(${W},'rq','r1',1,'x','succeeded','x')`);
  await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values(${W},'m1','r1',1,'rq','purchase',30,'active','logistic','v1','b','o','r','0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','{}','{}','{}','{}','x',now())`);
  await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status) values(${W},'r1',1,'m1',now(),'completed')`);
  await db.execute(sql`insert into opportunity_batches(workspace_id,id,radar_id,definition_version,model_version_id,score_cutoff,policy_version,status,is_current,trigger_reason,row_count,eligible_count,monetary_row_count,materialized_at) select ${W},'b1','r1',1,'m1',scoring_cutoff,'v1','completed',1,'test',2,2,0,now() from radar_score_batches where workspace_id=${W}`);
  await db.execute(sql`insert into opportunity_rows(workspace_id,id,batch_id,radar_id,customer_id,model_version_id,probability,score_band,scored_at,prediction_window_end,reason_codes,eligibility_state,created_at) values(${W},'o1','b1','r1','c1','m1',.8,'high',now(),now()+interval '30 days','[]','eligible',now()),(${W},'o2','b1','r1','c2','m1',.7,'high',now(),now()+interval '30 days','[]','eligible',now())`);
}

before(async () => {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
  db = createDb();
  decisions = new DecisionsService(db, new AuditService(db));
  await seed();
});

after(async () => {
  await closeClickHouse();
  await closeDb(db);
});

async function addOpportunityFixture(prefix:string,count:number) {
  await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at)
    select ${W},${prefix}||g::text,'identified','decision-test',now(),now() from generate_series(1,${count}) g`);
  await db.execute(sql`insert into opportunity_rows(workspace_id,id,batch_id,radar_id,customer_id,model_version_id,probability,score_band,scored_at,prediction_window_end,reason_codes,eligibility_state,created_at)
    select ${W},${`opp-${prefix}`}||g::text,'b1','r1',${prefix}||g::text,'m1',.75,'high',now(),now()+interval '30 days','["runtime"]'::jsonb,'eligible',now()
    from generate_series(1,${count}) g`);
  return db.execute(sql`select * from opportunity_rows where workspace_id=${W} and id like ${`opp-${prefix}%`} order by id`) as Promise<any[]>;
}

test('Decision immutable provenance, idempotency, do-nothing, rewards, identity and tenant isolation', async () => {
  const rows = await db.execute(sql`select * from opportunity_rows where workspace_id=${W}`) as any[];
  const first = await decisions.createForOpportunity(W, rows, { radarId:'r1', connectionId:'dest', correlationId:'corr', idempotencyKey:'activation' });
  const replay = await decisions.createForOpportunity(W, rows, { radarId:'r1', connectionId:'dest', correlationId:'corr', idempotencyKey:'activation' });
  assert.equal(first.length, 2);
  assert.equal(replay.length, 2);
  const [count] = await db.execute(sql`select count(*)::int n from decision_records where workspace_id=${W}`) as any[];
  assert.equal(count.n, 2);
  await decisions.recordExecution(W, [first[0].id], { connectionId:'dest', correlationId:'corr', idempotencyKey:'send', status:'succeeded', remoteId:'a555', counts:{ requested:1, succeeded:1 } });
  await decisions.recordDoNothing(W, first[1].id, 'none');
  await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at) values(${W},'p77','c1','purchase','canonical','purchase','d77','e77',149.90,'BRL','test',now())`);
  await decisions.reconcileRewards(W);
  const [reward] = await db.execute(sql`select * from reward_observations where workspace_id=${W} and decision_id=${first[0].id}`) as any[];
  assert.equal(reward.outcome_count, 1);
  assert.equal(reward.currency, 'BRL');
  await db.execute(sql`update customers set status='merged',merged_into_customer_id='c1' where workspace_id=${W} and id='c2'`);
  await decisions.reconcileRewards(W);
  const list = await decisions.list(W);
  assert.equal(list.length, 2);
  assert.equal((await decisions.list(O)).length, 0);
  const [pii] = await db.execute(sql`select count(*)::int n from information_schema.columns where table_name='decision_context_snapshots' and column_name in ('email','phone','token')`) as any[];
  assert.equal(pii.n, 0);
});

test('Phase A: canonical engagement runtime correlates delivery exactly once without tenant or identity leakage', async () => {
  const engagement = new EngagementWriteService(db, undefined as never, decisions);
  const [decision] = await db.execute(sql`select id from decision_records where workspace_id=${W} and customer_id='c1'`) as any[];
  const occurredAt = '2026-08-27T12:00:00.000Z';
  const delivered = { providerNamespace:'klaviyo', providerEventId:'evt-delivered-a', metricName:'Delivered Email', engagementKind:'delivery' as const, campaignId:'a555', correlationId:'corr', occurredAt };

  await engagement.upsertEvent(W, 'dest', 'c1', delivered);
  await engagement.upsertEvent(W, 'dest', 'c1', delivered);

  const deliveryRows = await db.execute(sql`select x.*,e.correlation_id,e.remote_id from exposure_observations x join action_executions e on e.workspace_id=x.workspace_id and e.id=x.execution_id where x.workspace_id=${W} and x.provider_event_id='evt-delivered-a'`) as any[];
  assert.equal(deliveryRows.length, 1);
  assert.equal(deliveryRows[0].decision_id, decision.id);
  assert.equal(deliveryRows[0].kind, 'delivered');
  assert.equal(deliveryRows[0].correlation_id, 'corr');
  assert.equal(deliveryRows[0].remote_id, 'a555');
  assert.equal(new Date(deliveryRows[0].occurred_at).toISOString(), occurredAt);

  await engagement.upsertEvent(W, 'dest', 'c1', { ...delivered, providerEventId:'evt-received-a', metricName:'Received Email', engagementKind:'received' });
  const [sent] = await db.execute(sql`select kind from exposure_observations where workspace_id=${W} and provider_event_id='evt-received-a'`) as any[];
  assert.equal(sent.kind, 'sent');

  await engagement.upsertEvent(W, 'dest', 'c1', { ...delivered, providerEventId:'evt-opened-a', metricName:'Opened Email', engagementKind:'opened' });
  await engagement.upsertEvent(W, 'dest', 'c1', { ...delivered, providerEventId:'evt-clicked-a', metricName:'Clicked Email', engagementKind:'clicked' });
  const engagementFacts = await db.execute(sql`select engagement_kind from engagement_events where workspace_id=${W} and provider_event_id in ('evt-delivered-a','evt-opened-a','evt-clicked-a') order by engagement_kind`) as any[];
  assert.deepEqual(engagementFacts.map((row) => row.engagement_kind).sort(), ['clicked','delivery','opened']);
  const [nonDeliveryExposure] = await db.execute(sql`select count(*)::int n from exposure_observations where workspace_id=${W} and provider_event_id in ('evt-opened-a','evt-clicked-a')`) as any[];
  assert.equal(nonDeliveryExposure.n, 0);

  await engagement.upsertEvent(W, 'dest', 'c1', { ...delivered, providerEventId:'evt-unrelated-a', campaignId:'unrelated', correlationId:'unrelated' });
  await engagement.upsertEvent(W, 'dest', 'c2', { ...delivered, providerEventId:'evt-customer-mismatch-a' });
  await engagement.upsertEvent(W, 'dest', 'c1', { ...delivered, providerEventId:'evt-no-key-a', campaignId:undefined, correlationId:undefined });
  await engagement.upsertEvent(O, 'dest', 'c1', { ...delivered, providerEventId:'evt-tenant-b-a' });
  const [rejected] = await db.execute(sql`select count(*)::int n from exposure_observations where provider_event_id in ('evt-unrelated-a','evt-customer-mismatch-a','evt-no-key-a','evt-tenant-b-a')`) as any[];
  assert.equal(rejected.n, 0);

  const learning = await decisions.learningRows(W, { action:'send_audience' });
  const noEvent = learning.items.find((row:any) => row.customer_id === 'c2');
  assert.equal(noEvent.exposure_state, 'not_observed');

  const [piiColumns] = await db.execute(sql`select count(*)::int n from information_schema.columns where table_name='exposure_observations' and column_name in ('email','phone')`) as any[];
  assert.equal(piiColumns.n, 0);
});

test('Phase B: ambiguous retry, exact five-customer partial results and activation replay stay logically singular', async () => {
  const [base] = await db.execute(sql`select id from decision_records where workspace_id=${W} and customer_id='c1'`) as any[];
  const beforeDecisions = await db.execute(sql`select id from decision_records where workspace_id=${W}`) as any[];
  const unknown = await decisions.recordExecution(W,[base.id],{ connectionId:'dest',correlationId:'retry-corr',idempotencyKey:'retry-logical',status:'unknown',failureCategory:'provider_timeout_ambiguous',counts:{ requested:1,succeeded:0 } });
  assert.equal(unknown[0].status,'unknown');
  assert.equal(unknown[0].attempts,1);
  const blocked = await decisions.recordExposureFromEngagement(W,{ connectionId:'dest',customerId:'c1',providerEventId:'evt-unknown-b',correlationId:'retry-corr',remoteId:null,kind:'delivered',occurredAt:new Date() });
  assert.equal(blocked,null);
  const resolved = await decisions.recordExecution(W,[base.id],{ connectionId:'dest',correlationId:'retry-corr',idempotencyKey:'retry-logical',status:'succeeded',remoteId:'remote-reconciled',counts:{ requested:1,succeeded:1 } });
  assert.equal(resolved[0].attempts,2);
  assert.equal(resolved[0].providerOperationKey,unknown[0].providerOperationKey);
  const attempts = await db.execute(sql`select attempt,status,failure_category from action_execution_attempts where workspace_id=${W} and execution_id=${unknown[0].id} order by attempt`) as any[];
  assert.deepEqual(attempts.map((row)=>row.status),['unknown','succeeded']);
  const [logicalExecution] = await db.execute(sql`select count(*)::int n from action_executions where workspace_id=${W} and idempotency_key=${`retry-logical:${base.id}`}`) as any[];
  assert.equal(logicalExecution.n,1);
  assert.equal((await db.execute(sql`select id from decision_records where workspace_id=${W}`) as any[]).length,beforeDecisions.length);

  const fixture = await addOpportunityFixture('partial-',5);
  const five = await decisions.createForOpportunity(W,fixture,{ radarId:'r1',connectionId:'dest',correlationId:'partial-corr',idempotencyKey:'partial-activation' });
  const perDecision: Record<string,{status:'succeeded'|'failed'|'unknown';failureCategory?:string}> = {};
  five.slice(0,3).forEach((item)=>{perDecision[item.id]={status:'succeeded'};});
  perDecision[five[3].id]={status:'failed',failureCategory:'provider_rejected'};
  perDecision[five[4].id]={status:'unknown',failureCategory:'provider_timeout_ambiguous'};
  await decisions.recordExecution(W,five.map((item)=>item.id),{ connectionId:'dest',correlationId:'partial-corr',idempotencyKey:'partial-send',status:'partially_succeeded',remoteId:'shared-provider-operation',counts:{ requested:5,succeeded:3,rejected:1,unknown:1 },perDecision });
  const partialRows = await db.execute(sql`select decision_id,status,provider_operation_key from action_executions where workspace_id=${W} and decision_id in (${sql.join(five.map((item)=>sql`${item.id}`),sql`,`)})`) as any[];
  assert.deepEqual(partialRows.reduce((acc:Record<string,number>,row)=>{acc[row.status]=(acc[row.status]??0)+1;return acc;},{}),{ succeeded:3,failed:1,unknown:1 });
  assert.equal(new Set(partialRows.map((row)=>row.provider_operation_key)).size,1);
  for (const item of five.slice(3)) {
    assert.equal(await decisions.recordExposureFromEngagement(W,{ connectionId:'dest',customerId:item.customerId,providerEventId:`evt-${item.id}`,correlationId:'partial-corr',remoteId:'shared-provider-operation',kind:'delivered',occurredAt:new Date() }),null);
  }

  const decisionCountBeforeReplay = (await db.execute(sql`select count(*)::int n from decision_records where workspace_id=${W} and decision_batch_id=(select decision_batch_id from decision_records where workspace_id=${W} and id=${five[0].id})`) as any[])[0].n;
  const exposureCountBeforeReplay = (await db.execute(sql`select count(*)::int n from exposure_observations where workspace_id=${W}`) as any[])[0].n;
  const rewardCountBeforeReplay = (await db.execute(sql`select count(*)::int n from reward_observations where workspace_id=${W}`) as any[])[0].n;
  const replay = await decisions.createForOpportunity(W,fixture,{ radarId:'r1',connectionId:'dest',correlationId:'partial-corr',idempotencyKey:'partial-activation' });
  assert.deepEqual(replay.map((item)=>item.id),five.map((item)=>item.id));
  assert.equal((await db.execute(sql`select count(*)::int n from decision_records where workspace_id=${W} and decision_batch_id=(select decision_batch_id from decision_records where workspace_id=${W} and id=${five[0].id})`) as any[])[0].n,decisionCountBeforeReplay);
  assert.equal((await db.execute(sql`select count(*)::int n from exposure_observations where workspace_id=${W}`) as any[])[0].n,exposureCountBeforeReplay);
  assert.equal((await db.execute(sql`select count(*)::int n from reward_observations where workspace_id=${W}`) as any[])[0].n,rewardCountBeforeReplay);
  const later = await decisions.createForOpportunity(W,fixture,{ radarId:'r1',connectionId:'dest',correlationId:'partial-later',idempotencyKey:'partial-activation-later' });
  assert.equal(later.length,5);
  assert.equal(later.some((item,index)=>item.id===five[index].id),false);
});

test('Phase C: learningRows is point-in-time, filterable, cursor-safe and reward-finality explicit', async () => {
  const suppression = new SuppressionService(db);
  const context = new CustomerContextService(db,suppression);
  const fixture = await addOpportunityFixture('learn-',1);
  await context.upsertTrait({ workspaceId:W,customerId:'learn-1',traitNamespace:'feature',traitKey:'segment',type:'string',value:'X',sourceNamespace:'decision-test',observedAt:new Date('2026-08-27T10:00:00Z') });
  const [created] = await decisions.createForOpportunity(W,fixture,{ radarId:'r1',connectionId:'dest',correlationId:'learn-corr',idempotencyKey:'learn-activation',policyVersion:'policy-learning-v1' });
  await decisions.recordExecution(W,[created.id],{ connectionId:'dest',correlationId:'learn-corr',idempotencyKey:'learn-send',status:'succeeded',remoteId:'learn-remote',counts:{requested:1,succeeded:1} });
  await context.upsertTrait({ workspaceId:W,customerId:'learn-1',traitNamespace:'feature',traitKey:'segment',type:'string',value:'Y',sourceNamespace:'decision-test',observedAt:new Date('2026-08-27T11:00:00Z') });

  await db.execute(sql`update radar_model_versions set status='retired' where workspace_id=${W} and id='m1'`);
  await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values(${W},'rq-m2','r1',1,'m2','succeeded','m2')`);
  await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values(${W},'m2','r1',1,'rq-m2','purchase',30,'active','logistic','v2','b','o2','r2','abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd','{}','{}','{}','{}','promoted',now())`);
  await db.execute(sql`update radars set current_model_reference='m2' where workspace_id=${W} and id='r1'`);

  const rows = await decisions.learningRows(W,{ radarId:'r1',modelVersionId:'m1',policyVersion:'policy-learning-v1',action:'send_audience',executionStatus:'succeeded',exposureState:'not_observed',rewardFinal:false,decisionFrom:'2020-01-01',decisionTo:'2030-01-01' });
  const learned = rows.items.find((row:any)=>row.decision_id===created.id);
  assert.equal(learned.decision_time_context.historicalContext['feature.segment'],'X');
  assert.equal(learned.model_version_id,'m1');
  assert.equal(learned.post_decision_execution.status,'succeeded');
  assert.equal(learned.exposure_state,'not_observed');
  assert.equal(learned.post_decision_reward.rewardFinal,false);
  assert.equal(learned.post_decision_reward.outcomeCount,null);
  const current = await context.getContext(W,'learn-1');
  assert.equal(current!.current_traits.find((trait)=>trait.traitNamespace==='feature'&&trait.traitKey==='segment')!.value,'Y');

  const seen:string[]=[]; let cursor:string|undefined;
  do { const page=await decisions.learningRows(W,{limit:2,cursor}); seen.push(...page.items.map((row:any)=>row.decision_id)); cursor=page.nextCursor??undefined; } while(cursor);
  const [total] = await db.execute(sql`select count(*)::int n from decision_records where workspace_id=${W}`) as any[];
  assert.equal(seen.length,total.n);
  assert.equal(new Set(seen).size,total.n);
  const firstPage = await decisions.learningRows(W,{limit:2});
  await assert.rejects(()=>decisions.learningRows(O,{cursor:firstPage.nextCursor!}),/invalid_learning_cursor/);
  await assert.rejects(()=>decisions.learningRows(W,{cursor:`${firstPage.nextCursor}tampered`}),/invalid_learning_cursor/);
  await assert.rejects(()=>decisions.learningRows(W,{executionStatus:'DROP TABLE'}),/invalid_execution_status_filter/);

  await db.execute(sql`update decision_records set reward_window_end=now()-interval '1 second' where workspace_id=${W} and id=${created.id}`);
  await decisions.reconcileDecision(W,created.id);
  const final = await decisions.learningRows(W,{rewardFinal:true,policyVersion:'policy-learning-v1'});
  assert.equal(final.items[0].post_decision_reward.rewardFinal,true);
  assert.equal(final.items[0].post_decision_reward.outcomeCount,0);
  assert.doesNotMatch(JSON.stringify(final.items[0]),/access_token|refresh_token|request_body|email|phone/i);
});

test('Phase D: Order 55 erasure redacts Decision identity/context, preserves provenance and enforces suppression before send', async () => {
  const suppression = new SuppressionService(db);
  const context = new CustomerContextService(db,suppression);
  const lifecycle = new DataLifecycleService(db,context,new AuditService(db),suppression);
  const fixture = await addOpportunityFixture('privacy-',1);
  await db.execute(sql`insert into customer_identifiers(workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at) values(${W},'privacy-id','privacy-1','external_id','decision-test','privacy-remote','decision-test',now(),now())`);
  await context.upsertTrait({ workspaceId:W,customerId:'privacy-1',traitNamespace:'feature',traitKey:'segment',type:'string',value:'sensitive-segment',sourceNamespace:'decision-test',observedAt:new Date() });
  const [created] = await decisions.createForOpportunity(W,fixture,{ radarId:'r1',connectionId:'dest',correlationId:'privacy-corr',idempotencyKey:'privacy-activation' });
  await decisions.recordExecution(W,[created.id],{ connectionId:'dest',correlationId:'privacy-corr',idempotencyKey:'privacy-send',status:'succeeded',remoteId:'privacy-remote-op',counts:{requested:1,succeeded:1} });
  await decisions.recordExposureFromEngagement(W,{ connectionId:'dest',customerId:'privacy-1',providerEventId:'privacy-delivery',correlationId:'privacy-corr',remoteId:'privacy-remote-op',kind:'delivered',occurredAt:new Date() });
  await decisions.reconcileDecision(W,created.id);
  const before = await decisions.learningRows(W,{policyVersion:'manual-opportunity-action-v1'});
  assert.equal(before.items.find((row:any)=>row.decision_id===created.id).decision_time_context.historicalContext['feature.segment'],'sensitive-segment');

  const erased = await lifecycle.requestSubjectDeletion(W,'privacy-1',{id:'runtime-owner'});
  assert.equal(erased.status,'completed',JSON.stringify(erased.stores));
  assert.equal(erased.stores.decision_learning_provenance.status,'completed');
  const after = await decisions.learningRows(W,{});
  const row = after.items.find((item:any)=>item.decision_id===created.id);
  assert.equal(row.customer_id,null);
  assert.equal(row.current_customer_id,null);
  assert.equal(row.subject_erased,true);
  assert.deepEqual(row.decision_time_context,{v:2,prediction:row.decision_time_context.prediction,commercial:row.decision_time_context.commercial,destination:row.decision_time_context.destination,eligibility:row.decision_time_context.eligibility,subjectErased:true});
  assert.equal(row.post_decision_execution.status,'succeeded');
  assert.equal(row.post_decision_exposure[0].kind,'delivered');
  assert.equal(await context.getContext(W,'privacy-1'),null);
  assert.equal(await suppression.isSuppressed(W,{providerNamespace:'decision-test',identifierType:'external_id',identifierValue:'privacy-remote'}),true);

  const allowed = await decisions.filterExecutableDecisions(W,[created.id]);
  const providerReceived:string[]=[];
  for (const item of allowed) providerReceived.push(item.customer_id);
  assert.deepEqual(providerReceived,[]);
  const eligible = await db.execute(sql`select action_type from decision_eligible_actions where workspace_id=${W} and decision_id=${created.id} order by action_type`) as any[];
  assert.deepEqual(eligible.map((item)=>item.action_type),['do_nothing','send_audience']);
  const [exposureCount] = await db.execute(sql`select count(*)::int n from exposure_observations where workspace_id=${W} and decision_id=${created.id}`) as any[];
  assert.equal(exposureCount.n,1);
  const [otherTenant] = await db.execute(sql`select deleted_at from customers where workspace_id=${O} and id='c1'`) as any[];
  assert.equal(otherTenant.deleted_at,null);
});

test('Phase E: 10k creation/query, concurrent idempotency, reward race and bounded leader-safe scheduler', async () => {
  const scale = await addOpportunityFixture('scale-',10000);
  const bulk = await decisions.createForOpportunity(W,scale,{radarId:'r1',connectionId:'dest',correlationId:'scale-corr',idempotencyKey:'scale-activation'});
  assert.equal(bulk.length,10000);
  assert.equal(DECISION_CREATE_CHUNK_SIZE,500);
  const [bulkCount] = await db.execute(sql`select count(*)::int n from decision_records where workspace_id=${W} and idempotency_key like 'scale-activation:%'`) as any[];
  assert.equal(bulkCount.n,10000);
  const [bulkAudit] = await db.execute(sql`select metadata from audit_log where workspace_id=${W} and resource_id=(select decision_batch_id from decision_records where workspace_id=${W} and id=${bulk[0].id}) order by at desc limit 1`) as any[];
  const auditMetadata = typeof bulkAudit.metadata === 'string' ? JSON.parse(bulkAudit.metadata) : bulkAudit.metadata;
  assert.equal(Number(auditMetadata.chunkSize),500);
  assert.equal(Number(auditMetadata.insertBatches),20);

  const first = await decisions.listPage(W,{limit:50});
  const second = await decisions.listPage(W,{limit:50,cursor:first.nextCursor!});
  assert.equal(first.items.length,50);
  assert.equal(second.items.length,50);
  assert.equal(first.items.some((left:any)=>second.items.some((right:any)=>right.id===left.id)),false);
  const learning = await decisions.learningRows(W,{radarId:'r1',modelVersionId:'m1',limit:50});
  assert.equal(learning.items.length,50);
  await db.execute(sql`set enable_seqscan=off`);
  const listPlan = await db.execute(sql`explain (format json) select id from decision_records where workspace_id=${W} and radar_id='r1' and created_at>=now()-interval '1 year' order by created_at desc limit 50`) as any[];
  const statePlan = await db.execute(sql`explain (format json) select d.id from decision_records d join action_executions e on e.workspace_id=d.workspace_id and e.decision_id=d.id where e.workspace_id=${W} and e.status='unknown' limit 50`) as any[];
  assert.match(JSON.stringify(listPlan),/decision_records_list_idx|Index Scan|Bitmap/);
  assert.match(JSON.stringify(statePlan),/action_executions_status_idx|Index Scan|Bitmap/);
  await db.execute(sql`set enable_seqscan=on`);

  const concurrentFixture = await addOpportunityFixture('concurrent-',1);
  const [sameA,sameB] = await Promise.all([
    decisions.createForOpportunity(W,concurrentFixture,{radarId:'r1',connectionId:'dest',correlationId:'concurrent-a',idempotencyKey:'concurrent-same'}),
    decisions.createForOpportunity(W,concurrentFixture,{radarId:'r1',connectionId:'dest',correlationId:'concurrent-b',idempotencyKey:'concurrent-same'}),
  ]);
  assert.equal(sameA[0].id,sameB[0].id);
  const [singular] = await db.execute(sql`select (select count(*) from decision_records where workspace_id=${W} and idempotency_key='concurrent-same:concurrent-1') decisions,(select count(*) from decision_context_snapshots where workspace_id=${W} and id=(select context_snapshot_id from decision_records where workspace_id=${W} and idempotency_key='concurrent-same:concurrent-1')) snapshots,(select count(*) from decision_eligible_actions where workspace_id=${W} and decision_id=${sameA[0].id}) actions`) as any[];
  assert.deepEqual([Number(singular.decisions),Number(singular.snapshots),Number(singular.actions)],[1,1,2]);
  const different = await Promise.all([
    decisions.createForOpportunity(W,concurrentFixture,{radarId:'r1',connectionId:'dest',correlationId:'different-a',idempotencyKey:'concurrent-different-a'}),
    decisions.createForOpportunity(W,concurrentFixture,{radarId:'r1',connectionId:'dest',correlationId:'different-b',idempotencyKey:'concurrent-different-b'}),
  ]);
  assert.notEqual(different[0][0].id,different[1][0].id);

  const raceDecision = bulk[0];
  await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at) values(${W},'race-outcome',${raceDecision.customerId},'purchase','canonical','purchase','race-dedupe','race-event',42,'BRL','runtime',now())`);
  await Promise.all([decisions.reconcileDecision(W,raceDecision.id),decisions.reconcileDecision(W,raceDecision.id)]);
  const [raceReward] = await db.execute(sql`select count(*)::int versions,max(outcome_count)::int outcomes,max(observed_value)::numeric value,count(distinct version)::int distinct_versions from reward_observations where workspace_id=${W} and decision_id=${raceDecision.id}`) as any[];
  assert.equal(raceReward.outcomes,1);
  assert.equal(Number(raceReward.value),42);
  assert.equal(raceReward.versions,raceReward.distinct_versions);

  await db.execute(sql`insert into decision_reward_reconciliation_checkpoints(workspace_id,last_decision_id) values(${W},null) on conflict(workspace_id) do update set last_decision_id=null`);
  const tick1 = await decisions.reconcileRewards(W,500);
  const tick2 = await decisions.reconcileRewards(W,500);
  assert.deepEqual([tick1.processed,tick2.processed],[500,500]);
  assert.equal(tick1.hasMore,true);
  assert.equal(tick2.hasMore,true);
  assert.notEqual(tick1.nextDecisionId,tick2.nextDecisionId);

  const redis = getRedis();
  await redis.del('truvo:cron:decision-reward-reconciliation');
  const calls:string[]=[];
  const rewardSweep={reconcileRewards:async(workspaceId:string)=>{calls.push(workspaceId);await new Promise((resolve)=>setTimeout(resolve,75));if(workspaceId===W)throw new Error('isolated-workspace-failure');}};
  const schedulerDb={select:()=>({from:async()=>[{id:W},{id:O}]})} as never;
  const fake={} as never;
  const make=()=>new SchedulerService(schedulerDb,fake,fake,fake,fake,fake,fake,fake,fake,fake,undefined,undefined,undefined,rewardSweep as never);
  const winners=await Promise.all([make().runDecisionRewardTick(),make().runDecisionRewardTick()]);
  assert.deepEqual(winners.sort(),[false,true]);
  assert.deepEqual(calls,[W,O]);
  await redis.quit();
});
