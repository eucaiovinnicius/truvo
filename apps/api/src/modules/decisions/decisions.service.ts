import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';

export const DECISION_CREATE_CHUNK_SIZE = 500;
export const DECISION_REWARD_CHUNK_SIZE = 500;

const EXECUTION_STATUSES = ['queued','attempting','succeeded','partially_succeeded','failed','unknown','cancelled'] as const;
const ACTIONS = ['do_nothing','send_audience'] as const;
const EXPOSURE_STATES = ['not_observed','sent','delivered','impression','audience_membership_confirmed'] as const;

type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
type DecisionResult = { status: ExecutionStatus; failureCategory?: string; counts?: Record<string, number> };
type LearningInput = {
  limit?: number;
  cursor?: string;
  radarId?: string;
  modelVersionId?: string;
  policyVersion?: string;
  action?: string;
  executionStatus?: string;
  exposureState?: string;
  rewardFinal?: boolean | string;
  decisionFrom?: string;
  decisionTo?: string;
};

function id(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\x1f')).digest('hex').slice(0, 26)}`;
}

function normalizedStatus(value: string): ExecutionStatus {
  const normalized = value === 'success' ? 'succeeded' : value === 'partial' ? 'partially_succeeded' : value;
  if (!EXECUTION_STATUSES.includes(normalized as ExecutionStatus)) throw new BadRequestException('invalid_execution_status');
  return normalized as ExecutionStatus;
}

function cursorChecksum(workspaceId: string, createdAt: string, decisionId: string): string {
  return createHash('sha256').update(`decision-learning-v1\x1f${workspaceId}\x1f${createdAt}\x1f${decisionId}`).digest('hex').slice(0, 20);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeHistoricalContext(value: unknown): Record<string,unknown> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string,unknown>).map(([key,item]) => [key,parseJsonValue(item)]));
}

@Injectable()
export class DecisionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly audit: AuditService) {}

  async createForOpportunity(
    workspaceId: string,
    rows: any[],
    meta: { radarId:string; connectionId:string; correlationId:string; idempotencyKey:string; policyVersion?:string },
  ) {
    if (!rows.length) return [];
    const batchId = rows[0].batch_id;
    if (rows.some((row) => row.batch_id !== batchId)) throw new BadRequestException('mixed_opportunity_batches');
    const [provenance] = await this.db.execute(sql`
      select b.definition_version,b.model_version_id,b.score_cutoff,d.outcome_definition_id target_outcome_definition_id,m.prediction_window_days
      from opportunity_batches b
      join radar_model_versions m on m.workspace_id=b.workspace_id and m.id=b.model_version_id
      join radar_definition_versions d on d.workspace_id=b.workspace_id and d.radar_id=b.radar_id and d.version=b.definition_version
      where b.workspace_id=${workspaceId} and b.id=${batchId}
    `) as any[];
    if (!provenance) throw new NotFoundException('decision_prediction_provenance_missing');

    const output: Array<{ id:string; customerId:string }> = [];
    let insertBatches = 0;
    for (let offset = 0; offset < rows.length; offset += DECISION_CREATE_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + DECISION_CREATE_CHUNK_SIZE);
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${meta.idempotencyKey}`},0))`);
        const [score] = await tx.execute(sql`
          select scoring_cutoff from radar_score_batches
          where workspace_id=${workspaceId} and radar_id=${meta.radarId}
            and model_version_id=${provenance.model_version_id} and scoring_cutoff=${provenance.score_cutoff}
        `) as any[];
        if (!score) throw new NotFoundException('decision_score_batch_missing');

        const keys = chunk.map((row) => `${meta.idempotencyKey}:${row.customer_id}`);
        const existingRows = await tx.execute(sql`
          select id,customer_id,idempotency_key from decision_records
          where workspace_id=${workspaceId} and idempotency_key in (${sql.join(keys.map((key) => sql`${key}`), sql`,`)})
        `) as any[];
        const existing = new Map(existingRows.map((row) => [row.idempotency_key, row]));
        const pending = chunk.filter((row) => !existing.has(`${meta.idempotencyKey}:${row.customer_id}`));

        const traitRows = pending.length ? await tx.execute(sql`
          select customer_id,coalesce(jsonb_object_agg(trait_namespace||'.'||trait_key,value),'{}'::jsonb) historical_context
          from customer_traits where workspace_id=${workspaceId}
            and customer_id in (${sql.join(pending.map((row) => sql`${row.customer_id}`), sql`,`)})
            and trait_namespace='feature' and deleted_at is null
          group by customer_id
        `) as any[] : [];
        const historical = new Map(traitRows.map((row) => [row.customer_id, normalizeHistoricalContext(row.historical_context)]));

        if (pending.length) {
          const prepared = pending.map((row) => {
            const key = `${meta.idempotencyKey}:${row.customer_id}`;
            return {
              row, key, decisionId:id('dec',workspaceId,key), snapshotId:id('dcs',workspaceId,key),
              snapshot: {
                v:2,
                prediction:{ probability:row.probability, band:row.score_band, signals:row.reason_codes, scoreCutoff:provenance.score_cutoff, modelVersionId:provenance.model_version_id },
                commercial:{ expectedRevenue:row.expected_revenue, currency:row.currency },
                destination:{ connectionId:meta.connectionId, capability:'outbound_audience' },
                eligibility:{ state:row.eligibility_state },
                historicalContext:historical.get(row.customer_id) ?? {},
              },
            };
          });
          await tx.execute(sql`insert into decision_context_snapshots(workspace_id,id,schema_version,snapshot) values ${sql.join(prepared.map((item) => sql`(${workspaceId},${item.snapshotId},2,${JSON.stringify(item.snapshot)}::text::jsonb)`), sql`,`)}`);
          await tx.execute(sql`
            insert into decision_records(workspace_id,id,customer_id,current_customer_id,radar_id,definition_version,model_version_id,score_batch_id,score_cutoff,opportunity_batch_id,opportunity_row_id,target_outcome_definition_id,policy_version,trigger_source,selected_action_type,context_snapshot_id,decision_batch_id,correlation_id,idempotency_key,reward_window_end)
            values ${sql.join(prepared.map((item) => sql`(
              ${workspaceId},${item.decisionId},${item.row.customer_id},${item.row.customer_id},${meta.radarId},${provenance.definition_version},${provenance.model_version_id},${provenance.score_cutoff},${provenance.score_cutoff},${item.row.batch_id},${item.row.id},${provenance.target_outcome_definition_id},${meta.policyVersion ?? 'manual-opportunity-action-v1'},'manual_user_action','send_audience',${item.snapshotId},${id('dcb',workspaceId,meta.idempotencyKey)},${meta.correlationId},${item.key},now()+(${provenance.prediction_window_days}||' days')::interval
            )`), sql`,`)}`);
          await tx.execute(sql`
            insert into decision_eligible_actions(workspace_id,decision_id,action_type,action_version,parameters) values
            ${sql.join(prepared.flatMap((item) => [
              sql`(${workspaceId},${item.decisionId},'do_nothing',1,'{}'::jsonb)`,
              sql`(${workspaceId},${item.decisionId},'send_audience',1,${JSON.stringify({ connectionId:meta.connectionId })}::jsonb)`,
            ]), sql`,`)}`);
          insertBatches += 1;
        }
        for (const row of chunk) {
          const key = `${meta.idempotencyKey}:${row.customer_id}`;
          output.push({ id:existing.get(key)?.id ?? id('dec',workspaceId,key), customerId:row.customer_id });
        }
      });
    }
    await this.audit.record({
      workspaceId, category:'decision', action:'decision.recorded', resourceType:'decision_batch',
      resourceId:id('dcb',workspaceId,meta.idempotencyKey),
      metadata:{ count:output.length, correlationId:meta.correlationId, chunkSize:DECISION_CREATE_CHUNK_SIZE, insertBatches },
    });
    return output;
  }

  async recordExecution(
    workspaceId:string,
    decisionIds:string[],
    input:{ connectionId:string; correlationId:string; idempotencyKey:string; status:string; remoteId?:string; counts:any; failureCategory?:string; perDecision?:Record<string,DecisionResult> },
  ) {
    const providerOperationKey = id('pop', workspaceId, input.idempotencyKey);
    const results = [];
    for (const decisionId of decisionIds) {
      const individual = input.perDecision?.[decisionId];
      const status = normalizedStatus(individual?.status ?? input.status);
      const counts = individual?.counts ?? input.counts;
      const failureCategory = individual?.failureCategory ?? input.failureCategory ?? null;
      const executionId = id('aex', workspaceId, input.idempotencyKey, decisionId);
      const [execution] = await this.db.execute(sql`
        insert into action_executions(workspace_id,id,decision_id,action_type,action_version,connection_id,correlation_id,idempotency_key,provider_operation_key,status,remote_id,counts,failure_category,attempts)
        values(${workspaceId},${executionId},${decisionId},'send_audience',1,${input.connectionId},${input.correlationId},${`${input.idempotencyKey}:${decisionId}`},${providerOperationKey},${status},${input.remoteId ?? null},${JSON.stringify(counts)}::jsonb,${failureCategory},1)
        on conflict(workspace_id,idempotency_key) do update set status=excluded.status,remote_id=excluded.remote_id,counts=excluded.counts,failure_category=excluded.failure_category,attempts=action_executions.attempts+1,updated_at=now()
        returning id,attempts,status
      `) as any[];
      await this.db.execute(sql`
        insert into action_execution_attempts(workspace_id,execution_id,attempt,status,remote_id,failure_category,provider_operation_key)
        values(${workspaceId},${execution.id},${execution.attempts},${status},${input.remoteId ?? null},${failureCategory},${providerOperationKey})
        on conflict(workspace_id,execution_id,attempt) do nothing
      `);
      results.push({ id:execution.id, decisionId, status, attempts:execution.attempts, providerOperationKey });
    }
    return results;
  }

  /** Final privacy gate immediately before a provider operation. Decision-time
   * eligibility remains immutable; this returns only subjects still actionable. */
  async filterExecutableDecisions(workspaceId:string, decisionIds:string[]) {
    if (!decisionIds.length) return [];
    return this.db.execute(sql`
      select d.id,d.customer_id from decision_records d
      join customers c on c.workspace_id=d.workspace_id and c.id=d.customer_id
      where d.workspace_id=${workspaceId}
        and d.id in (${sql.join(decisionIds.map((decisionId) => sql`${decisionId}`),sql`,`)})
        and c.status='identified' and c.deleted_at is null
    `) as Promise<Array<{ id:string;customer_id:string }>>;
  }

  async recordExposureFromEngagement(workspaceId:string,input:{ connectionId:string; customerId:string|null; providerEventId:string; correlationId?:string|null; remoteId?:string|null; kind:string; occurredAt:Date }) {
    const [match] = await this.db.execute(sql`
      select e.id execution_id,e.decision_id
      from action_executions e join decision_records d on d.workspace_id=e.workspace_id and d.id=e.decision_id
      where e.workspace_id=${workspaceId} and e.connection_id=${input.connectionId}
        and e.status in ('succeeded','partially_succeeded')
        and ((${input.correlationId ?? null}::text is not null and e.correlation_id=${input.correlationId ?? null}::text)
          or (${input.remoteId ?? null}::text is not null and e.remote_id=${input.remoteId ?? null}::text))
        ${input.customerId ? sql`and d.customer_id=${input.customerId}` : sql``}
      order by e.updated_at desc limit 1
    `) as any[];
    if (!match) return null;
    await this.db.execute(sql`
      insert into exposure_observations(workspace_id,id,decision_id,execution_id,kind,source_confidence,provider_event_id,occurred_at)
      values(${workspaceId},${id('exp',workspaceId,input.providerEventId)},${match.decision_id},${match.execution_id},${input.kind},'provider_confirmed',${input.providerEventId},${input.occurredAt.toISOString()}::timestamptz)
      on conflict(workspace_id,provider_event_id) do nothing
    `);
    return match.decision_id;
  }

  async reconcileRewards(workspaceId:string, limit=DECISION_REWARD_CHUNK_SIZE) {
    const boundedLimit = Math.min(Math.max(limit,1), DECISION_REWARD_CHUNK_SIZE);
    const [checkpoint] = await this.db.execute(sql`select last_decision_id from decision_reward_reconciliation_checkpoints where workspace_id=${workspaceId}`) as any[];
    const rows = await this.db.execute(sql`
      select id from decision_records where workspace_id=${workspaceId}
        ${checkpoint?.last_decision_id ? sql`and id>${checkpoint.last_decision_id}` : sql``}
      order by id limit ${boundedLimit}
    `) as any[];
    for (const row of rows) await this.reconcileDecision(workspaceId, row.id);
    const next = rows.length === boundedLimit ? rows.at(-1).id : null;
    await this.db.execute(sql`
      insert into decision_reward_reconciliation_checkpoints(workspace_id,last_decision_id,updated_at)
      values(${workspaceId},${next},now())
      on conflict(workspace_id) do update set last_decision_id=excluded.last_decision_id,updated_at=now()
    `);
    return { processed:rows.length, hasMore:next !== null, nextDecisionId:next };
  }

  async reconcileDecision(workspaceId:string, decisionId:string) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${decisionId}:reward`},0))`);
      const [decision] = await tx.execute(sql`select * from decision_records where workspace_id=${workspaceId} and id=${decisionId}`) as any[];
      if (!decision) return;
      const [canonical] = await tx.execute(sql`select coalesce(merged_into_customer_id,id) id from customers where workspace_id=${workspaceId} and id=${decision.customer_id}`) as any[];
      const current = canonical?.id ?? decision.customer_id;
      if (current !== decision.current_customer_id) await tx.execute(sql`update decision_records set current_customer_id=${current} where workspace_id=${workspaceId} and id=${decision.id}`);
      const [outcome] = await tx.execute(sql`
        select count(*)::int n,sum(value)::numeric value,count(distinct currency)::int currencies,max(currency) currency,min(observed_at) first,max(observed_at) last
        from customer_outcomes where workspace_id=${workspaceId} and customer_id in (${decision.customer_id},${current})
          and outcome_definition_id=${decision.target_outcome_definition_id} and deleted_at is null
          and observed_at>=${decision.created_at} and observed_at<=${decision.reward_window_end}
      `) as any[];
      const final = new Date(decision.reward_window_end) <= new Date();
      const [last] = await tx.execute(sql`select * from reward_observations where workspace_id=${workspaceId} and decision_id=${decision.id} order by version desc limit 1`) as any[];
      if (last && Number(last.outcome_count) === Number(outcome.n) && String(last.observed_value ?? '') === String(outcome.currencies === 1 ? outcome.value ?? '' : '') && Boolean(last.final) === final) return;
      const version = Number(last?.version ?? 0) + 1;
      await tx.execute(sql`
        insert into reward_observations(workspace_id,id,decision_id,version,outcome_count,observed_value,currency,first_outcome_at,last_outcome_at,final,reward_function_version)
        values(${workspaceId},${id('rwd',workspaceId,decision.id,String(version))},${decision.id},${version},${outcome.n},${outcome.currencies === 1 ? outcome.value : null},${outcome.currencies === 1 ? outcome.currency : null},${outcome.first ?? null},${outcome.last ?? null},${final},'target-occurrence-value-v1')
        on conflict(workspace_id,decision_id,version) do nothing
      `);
    });
  }

  async recordDoNothing(workspaceId:string, decisionId:string, correlationId:string) {
    const [decision] = await this.db.execute(sql`select id from decision_records where workspace_id=${workspaceId} and id=${decisionId}`) as any[];
    if (!decision) throw new NotFoundException('decision_not_found');
    await this.audit.record({ workspaceId,category:'decision',action:'decision.do_nothing',resourceType:'decision',resourceId:decisionId,metadata:{ correlationId } });
    return { id:decisionId,status:'not_sent' };
  }

  async list(workspaceId:string, limit=50) {
    return this.db.execute(sql`
      select d.*,case when c.deleted_at is null then d.customer_id else null end customer_id,
        (c.deleted_at is not null) subject_erased,e.status execution_status,r.outcome_count,r.observed_value,r.currency,r.final
      from decision_records d
      join customers c on c.workspace_id=d.workspace_id and c.id=d.customer_id
      left join lateral(select * from action_executions e where e.workspace_id=d.workspace_id and e.decision_id=d.id order by e.updated_at desc limit 1)e on true
      left join lateral(select * from reward_observations r where r.workspace_id=d.workspace_id and r.decision_id=d.id order by r.version desc limit 1)r on true
      where d.workspace_id=${workspaceId} order by d.created_at desc,d.id limit ${Math.min(Math.max(limit,1),200)}
    `);
  }

  async listPage(workspaceId:string, input:{ limit?:number; cursor?:string }={}) {
    const limit = Math.min(Math.max(input.limit ?? 50,1),200);
    const cursor = input.cursor ? this.decodeCursor(workspaceId,input.cursor) : null;
    const rows = await this.db.execute(sql`
      select d.id,d.created_at,d.created_at::text cursor_created_at,case when c.deleted_at is null then d.customer_id else null end customer_id,e.status execution_status
      from decision_records d join customers c on c.workspace_id=d.workspace_id and c.id=d.customer_id
      left join lateral(select status from action_executions e where e.workspace_id=d.workspace_id and e.decision_id=d.id order by e.updated_at desc limit 1)e on true
      where d.workspace_id=${workspaceId} ${cursor ? sql`and (d.created_at,d.id)<(${cursor.createdAt}::timestamptz,${cursor.decisionId})` : sql``}
      order by d.created_at desc,d.id desc limit ${limit + 1}
    `) as any[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0,limit);
    const last = items.at(-1);
    return { items,nextCursor:hasMore && last ? this.encodeCursor(workspaceId,last.cursor_created_at,last.id) : null };
  }

  async detail(workspaceId:string, decisionId:string) {
    const rows = await this.list(workspaceId,200);
    const result = (rows as any[]).find((row) => row.id === decisionId);
    if (!result) throw new NotFoundException('decision_not_found');
    return result;
  }

  async learningRows(workspaceId:string,input:LearningInput={}) {
    this.validateLearningInput(input);
    const limit = Math.min(Math.max(input.limit ?? 100,1),200);
    const cursor = input.cursor ? this.decodeCursor(workspaceId,input.cursor) : null;
    const rewardFinal = input.rewardFinal === undefined ? undefined : input.rewardFinal === true || input.rewardFinal === 'true';
    const from = input.decisionFrom ?? null;
    const to = input.decisionTo ?? null;
    const rows = await this.db.execute(sql`
      select d.id decision_id,d.workspace_id,d.created_at::text decision_cursor_at,
        case when c.deleted_at is null then d.customer_id else null end customer_id,
        case when c.deleted_at is null then d.current_customer_id else null end current_customer_id,
        (c.deleted_at is not null) subject_erased,d.radar_id,d.definition_version,d.model_version_id,d.score_batch_id,d.score_cutoff,
        d.opportunity_batch_id,d.opportunity_row_id,d.policy_version,d.selected_action_type,d.created_at decision_created_at,d.reward_window_end,
        s.schema_version,s.snapshot decision_time_context,
        (select jsonb_agg(jsonb_build_object('type',a.action_type,'version',a.action_version) order by a.action_type) from decision_eligible_actions a where a.workspace_id=d.workspace_id and a.decision_id=d.id) eligible_actions,
        case when e.id is null then null else jsonb_build_object('status',e.status,'attempts',e.attempts,'failureCategory',e.failure_category,'remoteId',e.remote_id,'providerOperationKey',e.provider_operation_key) end post_decision_execution,
        coalesce(x.facts,'[]'::jsonb) post_decision_exposure,
        coalesce(x.state,'not_observed') exposure_state,
        case when r.id is null then jsonb_build_object('outcomeCount',null,'observedValue',null,'currency',null,'rewardFinal',false,'state','open') else jsonb_build_object('outcomeCount',r.outcome_count,'observedValue',r.observed_value,'currency',r.currency,'rewardFinal',r.final,'state',case when r.final then 'final' else 'open' end) end post_decision_reward,
        coalesce(r.final,false) reward_final
      from decision_records d
      join decision_context_snapshots s on s.workspace_id=d.workspace_id and s.id=d.context_snapshot_id
      join customers c on c.workspace_id=d.workspace_id and c.id=d.customer_id
      left join lateral(select * from action_executions e where e.workspace_id=d.workspace_id and e.decision_id=d.id order by e.updated_at desc limit 1)e on true
      left join lateral(
        select jsonb_agg(jsonb_build_object('kind',z.kind,'occurredAt',z.occurred_at,'providerEventId',z.provider_event_id) order by z.occurred_at,z.id) facts,
          case when bool_or(z.kind='delivered') then 'delivered' when bool_or(z.kind='sent') then 'sent' else max(z.kind) end state
        from exposure_observations z where z.workspace_id=d.workspace_id and z.decision_id=d.id
      )x on true
      left join lateral(select * from reward_observations r where r.workspace_id=d.workspace_id and r.decision_id=d.id order by r.version desc limit 1)r on true
      where d.workspace_id=${workspaceId}
        ${input.radarId ? sql`and d.radar_id=${input.radarId}` : sql``}
        ${input.modelVersionId ? sql`and d.model_version_id=${input.modelVersionId}` : sql``}
        ${input.policyVersion ? sql`and d.policy_version=${input.policyVersion}` : sql``}
        ${input.action ? sql`and d.selected_action_type=${input.action}` : sql``}
        ${input.executionStatus ? sql`and e.status=${input.executionStatus}` : sql``}
        ${input.exposureState ? sql`and coalesce(x.state,'not_observed')=${input.exposureState}` : sql``}
        ${rewardFinal !== undefined ? sql`and coalesce(r.final,false)=${rewardFinal}` : sql``}
        ${from ? sql`and d.created_at>=${from}::timestamptz` : sql``}
        ${to ? sql`and d.created_at<=${to}::timestamptz` : sql``}
        ${cursor ? sql`and (d.created_at,d.id)<(${cursor.createdAt}::timestamptz,${cursor.decisionId})` : sql``}
      order by d.created_at desc,d.id desc limit ${limit + 1}
    `) as any[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0,limit).map((row) => ({
      ...row,
      decision_time_context:parseJsonValue(row.decision_time_context),
      eligible_actions:parseJsonValue(row.eligible_actions),
      post_decision_execution:parseJsonValue(row.post_decision_execution),
      post_decision_exposure:parseJsonValue(row.post_decision_exposure),
      post_decision_reward:parseJsonValue(row.post_decision_reward),
    }));
    const last = items.at(-1);
    return { items,nextCursor:hasMore && last ? this.encodeCursor(workspaceId,last.decision_cursor_at,last.decision_id) : null };
  }

  private validateLearningInput(input:LearningInput) {
    if (input.action && !ACTIONS.includes(input.action as typeof ACTIONS[number])) throw new BadRequestException('invalid_action_filter');
    if (input.executionStatus && !EXECUTION_STATUSES.includes(input.executionStatus as ExecutionStatus)) throw new BadRequestException('invalid_execution_status_filter');
    if (input.exposureState && !EXPOSURE_STATES.includes(input.exposureState as typeof EXPOSURE_STATES[number])) throw new BadRequestException('invalid_exposure_state_filter');
    if (input.rewardFinal !== undefined && ![true,false,'true','false'].includes(input.rewardFinal)) throw new BadRequestException('invalid_reward_final_filter');
    for (const value of [input.decisionFrom,input.decisionTo]) if (value && Number.isNaN(Date.parse(value))) throw new BadRequestException('invalid_decision_time_filter');
  }

  private encodeCursor(workspaceId:string, createdAt:Date|string, decisionId:string):string {
    const timestamp = typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
    return Buffer.from(JSON.stringify({ v:1,workspaceId,createdAt:timestamp,decisionId,checksum:cursorChecksum(workspaceId,timestamp,decisionId) })).toString('base64url');
  }

  private decodeCursor(workspaceId:string, value:string):{ createdAt:string;decisionId:string } {
    try {
      const parsed = JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Record<string,unknown>;
      if (parsed.v !== 1 || parsed.workspaceId !== workspaceId || typeof parsed.createdAt !== 'string' || typeof parsed.decisionId !== 'string' || parsed.checksum !== cursorChecksum(workspaceId,parsed.createdAt,parsed.decisionId) || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('invalid');
      return { createdAt:parsed.createdAt,decisionId:parsed.decisionId };
    } catch {
      throw new BadRequestException('invalid_learning_cursor');
    }
  }
}
