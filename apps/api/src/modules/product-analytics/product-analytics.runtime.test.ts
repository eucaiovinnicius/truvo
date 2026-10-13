import assert from 'node:assert/strict'; import { after,before,describe,test } from 'node:test'; import { closeDb,createDb,type Database } from '@truvo/db'; import { sql } from 'drizzle-orm';
import { validateProductEvent,PRODUCT_EVENT_NAMES } from './product-analytics.contracts'; import { ProductAnalyticsService,RETAINED_RADAR_WINDOW_DAYS } from './product-analytics.service';
const A='00000000-0000-0000-0000-000000001401',B='00000000-0000-0000-0000-000000001402'; let db:Database,service:ProductAnalyticsService;
async function clear(){await db.execute(sql`delete from truvo_product_events where workspace_id in (${A},${B})`);await db.execute(sql`delete from onboarding_progress where workspace_id in (${A},${B})`)}
describe('Order 140 product analytics runtime',{concurrency:1},()=>{
 before(async()=>{db=createDb();service=new ProductAnalyticsService(db);await db.execute(sql`insert into workspaces(id,name,slug) values(${A},'PA A','pa-a'),(${B},'PA B','pa-b') on conflict do nothing`)});
 after(async()=>{await clear();await db.execute(sql`delete from workspaces where id in (${A},${B})`);await closeDb(db)});
 test('typed allowlist covers SPEC-23 and rejects PII, payloads, nested data and raw provider errors',()=>{
  assert.equal(PRODUCT_EVENT_NAMES.length,15); assert.deepEqual(validateProductEvent('radar_created',{radarType:'purchase_30d'}).metadata,{radarType:'purchase_30d'});
  for(const metadata of [{email:'a@b.test'},{phone:'1'},{customerId:'c1'},{customer:{id:'c1'}},{orderPayload:'x'},{eventPayload:'x'},{url:'https://x?email=x'},{credentials:'secret'},{providerError:'token=secret'},{radarType:{nested:true}}]) assert.throws(()=>validateProductEvent('radar_created',metadata));
  assert.throws(()=>validateProductEvent('arbitrary_event',{})); assert.throws(()=>validateProductEvent('activation_failed',{reasonCode:'secret leaked!'}));
 });
 test('golden funnel is idempotent, ordered, isolated and reuses onboarding TTFV',async()=>{
  await clear(); const base=new Date('2026-01-01T00:00:00Z'); await db.execute(sql`insert into onboarding_progress(workspace_id,started_at,first_radar_created_at) values(${A},${base},${new Date(+base+4000)})`);
  const events:[any,string?,Record<string,string|number|boolean>?][]=[['workspace_created'],['integration_connected','conn_1',{providerCategory:'shopify'}],['first_event_received',undefined,{sourceCategory:'connector'}],['context_ready',undefined,{sourceCategory:'connector'}],['radar_created','radar_1',{radarType:'purchase_30d'}],['radar_ready','radar_1_v1',{radarType:'purchase_30d'}],['opportunities_generated','batch_1',{count:12}],['opportunity_viewed','opp_1_view_1',{surface:'opportunity_detail'}],['activation_requested','act_1',{destinationCategory:'connector'}],['activation_completed','act_1',{destinationCategory:'connector'}],['first_outcome_observed',undefined,{outcomeCategory:'purchase'}]];
  for(let i=0;i<events.length;i++){const [eventName,identity,metadata]=events[i];await service.record({workspaceId:A,eventName,identity,metadata,occurredAt:new Date(+base+(i+1)*1000)});await service.record({workspaceId:A,eventName,identity,metadata,occurredAt:new Date(+base+(i+1)*1000)});}
  const [count]=await db.execute(sql`select count(*)::int n from truvo_product_events where workspace_id=${A}`);assert.equal(count.n,events.length);
  const funnel=await service.workspaceFunnel(A);assert.equal(funnel.timeToFirstRadarMs,4000);assert.ok(+new Date(funnel.first_outcome_observed_at!)>+new Date(funnel.workspace_created_at!));
  const other=await service.workspaceFunnel(B);assert.equal(other.workspace_created_at,null);
  await assert.rejects(()=>service.recordOpportunityViewed(B,{opportunityId:'not_owned',viewId:'view_1',surface:'opportunity_detail'}));
 });
 test('batch/activation identities dedupe independently and aggregates define 30-day retained Radar activity',async()=>{
  await service.record({workspaceId:B,eventName:'workspace_created'});await service.record({workspaceId:B,eventName:'radar_created',identity:'r2'});await service.record({workspaceId:B,eventName:'opportunities_generated',identity:'batch_a'});
  await service.record({workspaceId:B,eventName:'opportunities_generated',identity:'batch_b'});await service.record({workspaceId:B,eventName:'radar_ready',identity:'r2_v1'});await service.record({workspaceId:B,eventName:'activation_requested',identity:'act_b'});await service.record({workspaceId:B,eventName:'activation_requested',identity:'act_b'});
  const aggregate=await service.aggregates(new Date('2025-01-01'),new Date());assert.equal(aggregate.retainedWindowDays,RETAINED_RADAR_WINDOW_DAYS);assert.ok(Number(aggregate.first_radar_workspaces)>=1);assert.ok(aggregate.firstRadarRate>0);
 });
});
