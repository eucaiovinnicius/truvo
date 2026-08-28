import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { EventContextQualityService } from '../data-quality/event-context-quality.service';
import { PropensityDispatchService } from './propensity-dispatch.service';
import { ModelRegistryService } from './model-registry.service';

export const RADAR_WINDOWS = [7, 14, 30, 60] as const;
export const DEFAULT_AUDIENCE = { version: 1, op: 'identified' } as const;
export const RADAR_MINIMUM_DATA_POLICY = Object.freeze({
  minLabeledExamples: 1000,
  minPositives: 100,
  minNegatives: 100,
});

const MAX_AUDIENCE_DEPTH = 8;
const transitions: Record<string, string[]> = {
  draft: ['validating_data', 'archived'],
  validating_data: ['ready_to_train', 'insufficient_data', 'failed'],
  insufficient_data: ['validating_data', 'archived'],
  ready_to_train: ['training', 'paused', 'archived', 'validating_data'],
  training: ['active', 'ready_to_train', 'failed', 'insufficient_data'],
  active: ['training', 'paused', 'archived', 'validating_data'],
  paused: ['ready_to_train', 'archived', 'validating_data'],
  failed: ['validating_data', 'archived'],
  archived: [],
};

export type AudienceAst =
  | { version: 1; op: 'identified' }
  | { version: 1; op: 'trait'; key: string; operator: 'eq' | 'exists'; value?: string | number | boolean }
  | { version: 1; op: 'outcome_occurred'; outcomeDefinitionId: string }
  | { version: 1; op: 'and' | 'or'; children: AudienceAst[] };
export type ActivationDestination = { connectionId: string; capability: 'activation' };

type RadarRow = {
  id: string;
  name: string;
  status: string;
  current_definition_version: number;
  current_model_reference: string | null;
};
type RadarDb = Pick<Database, 'execute' | 'transaction'>;
type DefinitionRow = {
  workspace_id: string;
  radar_id: string;
  version: number;
  outcome_definition_id: string;
  audience_ast: AudienceAst;
  prediction_window_days: number;
  optimization_goal: Record<string, unknown>;
  activation_destination: ActivationDestination | null;
  readiness: Record<string, unknown> | null;
  created_at: Date;
};

function parseJsonBoundary(value: unknown, field: string, nullable = false): unknown {
  if (value == null && nullable) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException(`Persisted Radar ${field} is invalid`);
  }
}

function objectJson(value: unknown, field: string, nullable = false): Record<string, unknown> | null {
  const parsed = parseJsonBoundary(value, field, nullable);
  if (parsed == null && nullable) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException(`Persisted Radar ${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function validateAudienceNode(ast: unknown, depth: number): AudienceAst {
  if (depth > MAX_AUDIENCE_DEPTH) throw new BadRequestException('Audience AST exceeds maximum depth');
  ast = parseJsonBoundary(ast, 'audience definition');
  if (!ast || typeof ast !== 'object' || (ast as { version?: unknown }).version !== 1) {
    throw new BadRequestException('Invalid audience AST version');
  }
  const node = ast as Record<string, unknown>;
  if (node.op === 'identified') return { version: 1, op: 'identified' };
  if (
    node.op === 'trait'
    && typeof node.key === 'string'
    && /^[a-z][a-z0-9_]{0,63}$/.test(node.key)
    && (node.operator === 'exists'
      || (node.operator === 'eq' && ['string', 'number', 'boolean'].includes(typeof node.value)))
  ) {
    return node as AudienceAst;
  }
  if (node.op === 'outcome_occurred' && typeof node.outcomeDefinitionId === 'string' && node.outcomeDefinitionId.length > 0) {
    return node as AudienceAst;
  }
  if ((node.op === 'and' || node.op === 'or') && Array.isArray(node.children) && node.children.length >= 2 && node.children.length <= 8) {
    return { version: 1, op: node.op, children: node.children.map((child) => validateAudienceNode(child, depth + 1)) };
  }
  throw new BadRequestException('Invalid canonical audience predicate');
}

export function validateAudienceAst(ast: unknown): AudienceAst {
  return validateAudienceNode(ast, 0);
}

function normalizeDestination(value: unknown): ActivationDestination | null {
  const parsed = objectJson(value, 'activation destination', true);
  if (parsed == null) return null;
  if (typeof parsed.connectionId !== 'string' || parsed.connectionId.length === 0 || parsed.capability !== 'activation') {
    throw new BadRequestException('Persisted Radar activation destination is invalid');
  }
  return { connectionId: parsed.connectionId, capability: 'activation' };
}

export function normalizeRadarDefinition(row: unknown): DefinitionRow {
  if (!row || typeof row !== 'object') throw new BadRequestException('Radar definition is missing');
  const raw = row as Record<string, unknown>;
  return {
    ...(raw as unknown as DefinitionRow),
    audience_ast: validateAudienceAst(raw.audience_ast),
    optimization_goal: objectJson(raw.optimization_goal, 'optimization goal') ?? {},
    activation_destination: normalizeDestination(raw.activation_destination),
    readiness: objectJson(raw.readiness, 'readiness', true),
  };
}

function configuredPolicy() {
  const number = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    minLabeledExamples: number('RADAR_MIN_LABELED_EXAMPLES', RADAR_MINIMUM_DATA_POLICY.minLabeledExamples),
    minPositives: number('RADAR_MIN_POSITIVES', RADAR_MINIMUM_DATA_POLICY.minPositives),
    minNegatives: number('RADAR_MIN_NEGATIVES', RADAR_MINIMUM_DATA_POLICY.minNegatives),
  };
}

function safeFailureReason(value?: string): string {
  const reason = (value?.trim() || 'training_failed').slice(0, 500);
  return reason
    .replace(/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]');
}

function safeFailureCategory(value?: string): string {
  const category = value?.trim();
  if (!category || !/^[a-z][a-z0-9_]{0,63}$/.test(category)) {
    throw new BadRequestException('Failed training result requires a safe failure category');
  }
  return category;
}

@Injectable()
export class RadarService {
  private readonly logger = new Logger(RadarService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly quality: EventContextQualityService,
    @Optional() private readonly propensityDispatch?: PropensityDispatchService,
    private readonly modelRegistry?: ModelRegistryService,
  ) {}

  private async radar(workspaceId: string, id: string, database: RadarDb = this.db): Promise<RadarRow> {
    const [row] = await database.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${id}`);
    if (!row) throw new NotFoundException('Radar not found');
    return row as unknown as RadarRow;
  }

  async create(workspaceId: string, input: {
    name: string;
    outcomeDefinitionId: string;
    audienceAst?: unknown;
    predictionWindowDays: number;
    optimizationGoal?: Record<string, unknown>;
    activationDestination?: ActivationDestination;
  }, database: RadarDb = this.db) {
    if (!RADAR_WINDOWS.includes(input.predictionWindowDays as 7)) {
      throw new BadRequestException('Prediction window must be 7, 14, 30, or 60 days');
    }
    const audience = validateAudienceAst(input.audienceAst ?? DEFAULT_AUDIENCE);
    await this.assertOutcome(workspaceId, input.outcomeDefinitionId, database);
    const destination = await this.validateDestination(workspaceId, input.activationDestination, database);
    const id = `rad_${randomUUID()}`;
    await database.transaction(async (tx) => {
      await tx.execute(sql`insert into radars (workspace_id,id,name,status,current_definition_version) values (${workspaceId},${id},${input.name},'draft',1)`);
      await tx.execute(sql`insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,activation_destination) values (${workspaceId},${id},1,${input.outcomeDefinitionId},${JSON.stringify(audience)}::jsonb,${input.predictionWindowDays},${JSON.stringify(input.optimizationGoal ?? {})}::jsonb,${destination ? JSON.stringify(destination) : null}::jsonb)`);
    });
    return this.get(workspaceId, id, database);
  }

  async get(workspaceId: string, id: string, database: RadarDb = this.db) {
    const radar = await this.radar(workspaceId, id, database);
    const [rawDefinition] = await database.execute(sql`select * from radar_definition_versions where workspace_id=${workspaceId} and radar_id=${id} and version=${radar.current_definition_version}`);
    const definition = normalizeRadarDefinition(rawDefinition);
    const [ml] = await database.execute(sql`
      select m.id as current_model_version,m.estimator_type,m.metrics,m.calibration,m.promoted_at as last_successful_training_at,
             scores.latest_scoring_at,scores.scored_customer_count,
             training.status as training_state
      from radars r
      left join radar_model_versions m on m.workspace_id=r.workspace_id and m.id=r.current_model_reference
      left join lateral (
        select max(scored_at) as latest_scoring_at,count(distinct customer_id)::int as scored_customer_count
        from radar_propensity_scores s where s.workspace_id=r.workspace_id and s.radar_id=r.id
          and s.model_version_id=r.current_model_reference
      ) scores on true
      left join lateral (
        select status from radar_training_requests tr where tr.workspace_id=r.workspace_id and tr.radar_id=r.id
        order by tr.created_at desc limit 1
      ) training on true
      where r.workspace_id=${workspaceId} and r.id=${id}`);
    return {
      radar,
      definition,
      activationReadiness: await this.activationReadiness(workspaceId, definition.activation_destination, database),
      ml: ml ? {
        currentModelVersion: (ml as { current_model_version?: string | null }).current_model_version ?? null,
        estimatorType: (ml as { estimator_type?: string | null }).estimator_type ?? null,
        validationMetrics: parseJsonBoundary((ml as { metrics?: unknown }).metrics, 'model metrics', true),
        calibration: parseJsonBoundary((ml as { calibration?: unknown }).calibration, 'model calibration', true),
        lastSuccessfulTrainingAt: (ml as { last_successful_training_at?: Date | null }).last_successful_training_at ?? null,
        latestScoringAt: (ml as { latest_scoring_at?: Date | null }).latest_scoring_at ?? null,
        scoredCustomerCount: Number((ml as { scored_customer_count?: number | null }).scored_customer_count ?? 0),
        trainingState: (ml as { training_state?: string | null }).training_state ?? null,
      } : null,
    };
  }

  async requiresValidation(workspaceId: string, id: string) {
    return ['draft', 'validating_data'].includes((await this.radar(workspaceId, id)).status);
  }

  async list(workspaceId: string) {
    return this.db.execute(sql`select r.*, d.outcome_definition_id, d.prediction_window_days from radars r join radar_definition_versions d on d.workspace_id=r.workspace_id and d.radar_id=r.id and d.version=r.current_definition_version where r.workspace_id=${workspaceId} order by r.updated_at desc`);
  }

  async availableOutcomes(workspaceId: string) {
    return this.db.execute(sql`select id,name,outcome_namespace,outcome_key,kind from outcome_definitions where workspace_id=${workspaceId} and is_active=true and deleted_at is null order by name`);
  }

  audienceMetadata() {
    return {
      version: 1,
      fields: [
        { kind: 'identified', operators: ['exists'] },
        { kind: 'trait', operators: ['eq', 'exists'], keyPattern: '^[a-z][a-z0-9_]{0,63}$' },
        { kind: 'outcome_occurred', operators: ['exists'] },
      ],
      logical: ['and', 'or'],
      maxDepth: MAX_AUDIENCE_DEPTH,
    };
  }

  async activationDestinations(workspaceId: string) {
    return this.db.execute(sql`select id,provider,display_name,lifecycle_state,capabilities from connector_connections where workspace_id=${workspaceId} and role in ('destination','bidirectional') and 'activation' = any(select jsonb_array_elements_text(capabilities)) order by display_name`);
  }

  async audienceCount(workspaceId: string, ast: unknown): Promise<number> {
    const [ids, eligible] = await Promise.all([
      this.audienceIds(workspaceId, validateAudienceAst(ast)),
      this.audienceIds(workspaceId, DEFAULT_AUDIENCE),
    ]);
    return [...ids].filter((id) => eligible.has(id)).length;
  }

  private async audienceIds(workspaceId: string, ast: AudienceAst): Promise<Set<string>> {
    if (ast.op === 'identified') {
      const rows = await this.db.execute(sql`select id from customers where workspace_id=${workspaceId} and status='identified' and deleted_at is null`);
      return new Set((rows as unknown as { id: string }[]).map((row) => row.id));
    }
    if (ast.op === 'trait') {
      const rows = ast.operator === 'exists'
        ? await this.db.execute(sql`select customer_id from customer_traits where workspace_id=${workspaceId} and trait_namespace='canonical' and trait_key=${ast.key} and deleted_at is null`)
        : await this.db.execute(sql`select customer_id from customer_traits where workspace_id=${workspaceId} and trait_namespace='canonical' and trait_key=${ast.key} and value::text=${JSON.stringify(ast.value)} and deleted_at is null`);
      return new Set((rows as unknown as { customer_id: string }[]).map((row) => row.customer_id));
    }
    if (ast.op === 'outcome_occurred') {
      const rows = await this.db.execute(sql`select distinct customer_id from customer_outcomes where workspace_id=${workspaceId} and outcome_definition_id=${ast.outcomeDefinitionId} and deleted_at is null`);
      return new Set((rows as unknown as { customer_id: string }[]).map((row) => row.customer_id));
    }
    const groups = await Promise.all(ast.children.map((child) => this.audienceIds(workspaceId, child)));
    if (ast.op === 'or') return new Set(groups.flatMap((group) => [...group]));
    return new Set([...groups[0]!].filter((customerId) => groups.every((group) => group.has(customerId))));
  }

  /** Computes the same immutable-definition readiness used by validation, without writing Radar state. */
  private async readinessForDefinition(workspaceId: string, definition: Pick<DefinitionRow, 'version' | 'audience_ast' | 'outcome_definition_id' | 'prediction_window_days' | 'activation_destination'>) {
    const eligibleIds = await this.audienceIds(workspaceId, definition.audience_ast);
    const privacyEligibleIds = await this.audienceIds(workspaceId, DEFAULT_AUDIENCE);
    const eligible = new Set([...eligibleIds].filter((customerId) => privacyEligibleIds.has(customerId)));
    const outcomeRows = await this.db.execute(sql`select distinct customer_id from customer_outcomes where workspace_id=${workspaceId} and outcome_definition_id=${definition.outcome_definition_id} and deleted_at is null`);
    const [targetOutcome] = await this.db.execute(sql`select id from outcome_definitions where workspace_id=${workspaceId} and id=${definition.outcome_definition_id} and is_active=true and deleted_at is null`);
    const positiveIds = new Set((outcomeRows as unknown as { customer_id: string }[]).map((row) => row.customer_id));
    const positives = [...eligible].filter((customerId) => positiveIds.has(customerId)).length;
    const negatives = eligible.size - positives;
    const customerHistory = await this.db.execute(sql`select id,first_seen_at from customers where workspace_id=${workspaceId} and status='identified' and deleted_at is null`);
    const earliest = (customerHistory as unknown as { id: string; first_seen_at: Date }[])
      .filter((row) => eligible.has(row.id))
      .reduce<number | null>((minimum, row) => {
        const observed = new Date(row.first_seen_at).getTime();
        return minimum == null || observed < minimum ? observed : minimum;
      }, null);
    const historyDays = earliest == null ? 0 : Math.max(0, Math.floor((Date.now() - earliest) / 86_400_000));
    const quality = await this.quality.evaluate(workspaceId, {
      requiredDimensions: ['identity'], outcomeKey: definition.outcome_definition_id, historicalWindowDays: definition.prediction_window_days,
    });
    const policy = configuredPolicy();
    const reasonCodes: string[] = [];
    if (eligible.size < policy.minLabeledExamples) reasonCodes.push('insufficient_labeled_examples');
    if (positives < policy.minPositives) reasonCodes.push('insufficient_positive_outcomes');
    if (negatives < policy.minNegatives) reasonCodes.push('insufficient_negative_examples');
    if (historyDays < definition.prediction_window_days) reasonCodes.push('insufficient_history');
    if (!targetOutcome) reasonCodes.push('target_outcome_unavailable');
    if (quality.criticalCount) reasonCodes.push('blocking_quality_issues');
    const status = reasonCodes.length ? 'insufficient_data' : 'ready_to_train';
    const activationReadiness = await this.activationReadiness(workspaceId, definition.activation_destination);
    return {
      status, definitionVersion: definition.version, eligibleCustomerCount: eligible.size, positiveOutcomeCount: positives, negativeCount: negatives,
      historyDays, minimumHistoryDays: definition.prediction_window_days, policy, quality, blockers: reasonCodes,
      warnings: [...(quality.warningsCount ? ['quality_warnings'] : []), ...(activationReadiness.status === 'unavailable' ? [activationReadiness.reasonCode] : [])],
      reasonCodes, activationReadiness,
    };
  }

  async previewReadiness(workspaceId: string, input: {
    outcomeDefinitionId: string; audienceAst?: unknown; predictionWindowDays: number; activationDestination?: ActivationDestination;
  }) {
    if (!RADAR_WINDOWS.includes(input.predictionWindowDays as 7)) throw new BadRequestException('Prediction window must be 7, 14, 30, or 60 days');
    await this.assertOutcome(workspaceId, input.outcomeDefinitionId);
    const activationDestination = await this.validateDestination(workspaceId, input.activationDestination);
    return this.readinessForDefinition(workspaceId, {
      version: 1, outcome_definition_id: input.outcomeDefinitionId, audience_ast: validateAudienceAst(input.audienceAst ?? DEFAULT_AUDIENCE),
      prediction_window_days: input.predictionWindowDays, activation_destination: activationDestination,
    });
  }

  async validate(workspaceId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`radar-validation:${workspaceId}:${id}`}))`);
      const { radar, definition } = await this.get(workspaceId, id, tx);
      if (radar.status !== 'validating_data') {
        this.transition(radar.status, 'validating_data');
        const [started] = await tx.execute(sql`update radars set status='validating_data',updated_at=now() where workspace_id=${workspaceId} and id=${id} and current_definition_version=${definition.version} and status=${radar.status} returning id`);
        if (!started) throw new BadRequestException('Radar definition changed before validation started');
      }
      this.logger.log(`Radar validation requested workspace=${workspaceId} radar=${id} definition=${definition.version}`);
      const readiness = await this.readinessForDefinition(workspaceId, definition);
      this.transition('validating_data', readiness.status);
      const [completed] = await tx.execute(sql`update radars set status=${readiness.status},updated_at=now() where workspace_id=${workspaceId} and id=${id} and current_definition_version=${definition.version} and status='validating_data' returning id`);
      if (!completed) throw new BadRequestException('Radar definition changed during validation');
      await tx.execute(sql`update radar_definition_versions set readiness=${JSON.stringify(readiness)}::jsonb where workspace_id=${workspaceId} and radar_id=${id} and version=${definition.version}`);
      this.logger.log(`Radar validation completed workspace=${workspaceId} radar=${id} definition=${definition.version} status=${readiness.status}`);
      return readiness;
    });
  }

  async train(workspaceId: string, id: string, key: string) {
    if (!key.trim()) throw new BadRequestException('Idempotency key is required');
    const accepted = await this.db.transaction(async (tx) => {
      const [row] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${id} for update`);
      if (!row) throw new NotFoundException('Radar not found');
      const radar = row as unknown as RadarRow;
      if (radar.status === 'archived') throw new BadRequestException('Archived Radar cannot train');
      const [sameKey] = await tx.execute(sql`select * from radar_training_requests where workspace_id=${workspaceId} and radar_id=${id} and definition_version=${radar.current_definition_version} and idempotency_key=${key}`);
      if (sameKey) return sameKey;
      const [existing] = await tx.execute(sql`select * from radar_training_requests where workspace_id=${workspaceId} and radar_id=${id} and definition_version=${radar.current_definition_version} order by created_at desc limit 1`);
      if (existing) {
        if (radar.status === 'ready_to_train' && (existing as { status?: string }).status === 'failed') {
          const correlationId = randomUUID();
          const [retried] = await tx.execute(sql`update radar_training_requests set status='accepted',idempotency_key=${key},correlation_id=${correlationId},model_reference=null,failure_category=null,failure_reason=null,claimed_by=null,claimed_at=null,lease_expires_at=null,terminal_at=null,updated_at=now() where workspace_id=${workspaceId} and id=${(existing as { id: string }).id} returning *`);
          await tx.execute(sql`update radars set status='training',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
          this.logger.log(`Radar training request retried workspace=${workspaceId} radar=${id} definition=${radar.current_definition_version}`);
          return retried;
        }
        if (radar.status === 'training') {
          this.logger.log(`Radar training request reused workspace=${workspaceId} radar=${id} definition=${radar.current_definition_version}`);
          return existing;
        }
        if (radar.status !== 'active') throw new BadRequestException('Radar is not ready to train');
      }
      if (radar.status !== 'ready_to_train' && radar.status !== 'active') throw new BadRequestException('Radar is not ready to train');
      const [definitionRaw] = await tx.execute(sql`select readiness from radar_definition_versions where workspace_id=${workspaceId} and radar_id=${id} and version=${radar.current_definition_version}`);
      const readiness = objectJson((definitionRaw as { readiness?: unknown } | undefined)?.readiness, 'readiness', true);
      if (readiness?.status !== 'ready_to_train' || readiness.definitionVersion !== radar.current_definition_version) {
        throw new BadRequestException('Current Radar definition has no valid readiness approval');
      }
      const requestId = `rtr_${randomUUID()}`;
      const correlationId = randomUUID();
      const [request] = await tx.execute(sql`insert into radar_training_requests (workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values (${workspaceId},${requestId},${id},${radar.current_definition_version},${key},'accepted',${correlationId}) returning *`);
      await tx.execute(sql`update radars set status='training',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
      this.logger.log(`Radar training request accepted workspace=${workspaceId} radar=${id} definition=${radar.current_definition_version}`);
      return request;
    });
    if (this.propensityDispatch) {
      try {
        await this.propensityDispatch.dispatchTraining(accepted as unknown as { workspace_id: string; radar_id: string; definition_version: number; id: string; correlation_id: string });
      } catch (error) {
        this.logger.warn(`Radar training wake-up failed; durable scheduler will recover workspace=${workspaceId} radar=${id}: ${(error as Error).message}`);
      }
    }
    return accepted;
  }

  async reportTrainingResult(
    workspaceId: string,
    id: string,
    version: number,
    requestId: string,
    result: { status: 'succeeded' | 'failed' | 'insufficient_data'; modelReference?: string; failureCategory?: string; failureReason?: string },
  ) {
    if (this.modelRegistry) return this.modelRegistry.reportTrainingResult(workspaceId, id, version, requestId, result);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${id} for update`);
      if (!row) throw new NotFoundException('Radar not found');
      const radar = row as unknown as RadarRow;
      const [request] = await tx.execute(sql`select * from radar_training_requests where workspace_id=${workspaceId} and id=${requestId} and radar_id=${id} and definition_version=${version} for update`);
      if (!request) throw new BadRequestException('Training request does not match Radar definition');
      const prior = request as { status: string; model_reference: string | null; failure_category: string | null };
      if (prior.status === 'succeeded' || prior.status === 'failed' || prior.status === 'insufficient_data') {
        const sameSuccess = prior.status === 'succeeded'
          && result.status === 'succeeded'
          && prior.model_reference === result.modelReference?.trim();
        const sameFailure = prior.status === 'failed'
          && result.status === 'failed'
          && prior.failure_category === result.failureCategory;
        const sameInsufficient = prior.status === 'insufficient_data' && result.status === 'insufficient_data';
        if (sameSuccess || sameFailure || sameInsufficient) return;
        throw new BadRequestException('Training result conflicts with an already accepted result');
      }
      if (radar.current_definition_version !== version || radar.status !== 'training') {
        this.logger.warn(`Stale Radar training result rejected workspace=${workspaceId} radar=${id} definition=${version}`);
        throw new BadRequestException('Stale training result cannot change current Radar');
      }
      if (result.status === 'succeeded') {
        const modelReference = result.modelReference?.trim();
        if (!modelReference) throw new BadRequestException('Successful training result requires model reference');
        const [verifiedModel] = await tx.execute(sql`
          select m.id from radar_model_versions m where m.workspace_id=${workspaceId} and m.id=${modelReference}
            and m.radar_id=${id} and m.definition_version=${version} and m.training_request_id=${requestId}
            and m.verified_at is not null and m.status in ('candidate','training','validated','active') and exists (
              select 1 from radar_score_batches b where b.workspace_id=m.workspace_id and b.radar_id=m.radar_id
                and b.model_version_id=m.id and b.status='completed'
            )`);
        if (!verifiedModel) throw new BadRequestException('Successful training result requires verified model and completed score batch');
        await tx.execute(sql`update radar_training_requests set status='succeeded',model_reference=${modelReference},failure_category=null,failure_reason=null,claimed_by=null,lease_expires_at=null,terminal_at=now(),updated_at=now() where workspace_id=${workspaceId} and id=${requestId}`);
        await tx.execute(sql`update radar_model_versions set status='retired' where workspace_id=${workspaceId} and radar_id=${id} and status='active' and id<>${modelReference}`);
        await tx.execute(sql`update radar_model_versions set status='active',promoted_at=coalesce(promoted_at,now()) where workspace_id=${workspaceId} and id=${modelReference}`);
        await tx.execute(sql`update radars set status='active',current_model_reference=${modelReference},updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
      } else if (result.status === 'insufficient_data') {
        await tx.execute(sql`update radar_training_requests set status='insufficient_data',failure_category='insufficient_data',failure_reason=${safeFailureReason(result.failureReason)},model_reference=null,claimed_by=null,lease_expires_at=null,terminal_at=now(),updated_at=now() where workspace_id=${workspaceId} and id=${requestId}`);
        if (radar.current_model_reference) {
          await tx.execute(sql`update radars set status='active',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
        } else {
          await tx.execute(sql`update radars set status='insufficient_data',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
        }
      } else {
        await tx.execute(sql`update radar_training_requests set status='failed',failure_category=${safeFailureCategory(result.failureCategory)},failure_reason=${safeFailureReason(result.failureReason)},model_reference=null,claimed_by=null,lease_expires_at=null,terminal_at=now(),updated_at=now() where workspace_id=${workspaceId} and id=${requestId}`);
        if (radar.current_model_reference) {
          await tx.execute(sql`update radars set status='active',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
        } else {
          await tx.execute(sql`update radars set status='failed',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
        }
      }
    });
  }

  async patch(workspaceId: string, id: string, input: {
    name?: string;
    outcomeDefinitionId?: string;
    audienceAst?: unknown;
    predictionWindowDays?: number;
    activationDestination?: ActivationDestination;
  }) {
    const semantic = input.outcomeDefinitionId !== undefined
      || input.audienceAst !== undefined
      || input.predictionWindowDays !== undefined
      || input.activationDestination !== undefined;
    if (!semantic && input.name) {
      await this.db.execute(sql`update radars set name=${input.name},updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
      return this.get(workspaceId, id);
    }
    return this.db.transaction(async (tx) => {
      const [radarRaw] = await tx.execute(sql`select * from radars where workspace_id=${workspaceId} and id=${id} for update`);
      if (!radarRaw) throw new NotFoundException('Radar not found');
      const radar = radarRaw as unknown as RadarRow;
      if (radar.status === 'archived') throw new BadRequestException('Archived Radar cannot be changed');
      const [definitionRaw] = await tx.execute(sql`select * from radar_definition_versions where workspace_id=${workspaceId} and radar_id=${id} and version=${radar.current_definition_version}`);
      const current = normalizeRadarDefinition(definitionRaw);
      const nextVersion = radar.current_definition_version + 1;
      const predictionWindowDays = input.predictionWindowDays ?? current.prediction_window_days;
      if (!RADAR_WINDOWS.includes(predictionWindowDays as 7)) throw new BadRequestException('Invalid prediction window');
      const audience = validateAudienceAst(input.audienceAst ?? current.audience_ast);
      const outcomeDefinitionId = input.outcomeDefinitionId ?? current.outcome_definition_id;
      const [outcome] = await tx.execute(sql`select id from outcome_definitions where workspace_id=${workspaceId} and id=${outcomeDefinitionId} and is_active=true and deleted_at is null`);
      if (!outcome) throw new BadRequestException('Target outcome is not an active canonical outcome definition');
      const destination = input.activationDestination === undefined
        ? current.activation_destination
        : await this.validateDestination(workspaceId, input.activationDestination);
      await tx.execute(sql`insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,activation_destination) values (${workspaceId},${id},${nextVersion},${outcomeDefinitionId},${JSON.stringify(audience)}::jsonb,${predictionWindowDays},${JSON.stringify(current.optimization_goal)}::jsonb,${destination ? JSON.stringify(destination) : null}::jsonb)`);
      await tx.execute(sql`update radars set name=${input.name ?? radar.name},current_definition_version=${nextVersion},current_model_reference=null,status='draft',updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
      return { id, nextVersion };
    }).then(() => this.get(workspaceId, id));
  }

  async action(workspaceId: string, id: string, target: 'paused' | 'archived') {
    const radar = await this.radar(workspaceId, id);
    this.transition(radar.status, target);
    await this.setStatus(workspaceId, id, target);
  }

  private transition(from: string, to: string) {
    if (!transitions[from]?.includes(to)) throw new BadRequestException(`Illegal Radar transition: ${from} -> ${to}`);
  }

  private async assertOutcome(workspaceId: string, outcomeDefinitionId: string, database: RadarDb = this.db) {
    const [outcome] = await database.execute(sql`select id from outcome_definitions where workspace_id=${workspaceId} and id=${outcomeDefinitionId} and is_active=true and deleted_at is null`);
    if (!outcome) throw new BadRequestException('Target outcome is not an active canonical outcome definition');
  }

  private async validateDestination(workspaceId: string, destination?: ActivationDestination, database: RadarDb = this.db) {
    if (!destination) return null;
    if (destination.capability !== 'activation') throw new BadRequestException('Unsupported activation capability');
    const [connection] = await database.execute(sql`select id,capabilities from connector_connections where workspace_id=${workspaceId} and id=${destination.connectionId} and role in ('destination','bidirectional')`);
    if (
      !connection
      || !Array.isArray((connection as { capabilities?: unknown }).capabilities)
      || !(connection as { capabilities: string[] }).capabilities.includes('activation')
    ) {
      throw new BadRequestException('Activation destination is not a compatible workspace connection');
    }
    return { connectionId: destination.connectionId, capability: 'activation' as const };
  }

  private async activationReadiness(workspaceId: string, destination: ActivationDestination | null, database: RadarDb = this.db) {
    if (!destination) return { status: 'not_configured' as const, reasonCode: null };
    const [connection] = await database.execute(sql`select lifecycle_state,capabilities from connector_connections where workspace_id=${workspaceId} and id=${destination.connectionId} and role in ('destination','bidirectional')`);
    if (
      !connection
      || !Array.isArray((connection as { capabilities?: unknown }).capabilities)
      || !(connection as { capabilities: string[] }).capabilities.includes(destination.capability)
    ) {
      return { status: 'unavailable' as const, reasonCode: 'activation_destination_unavailable' as const };
    }
    const lifecycle = (connection as { lifecycle_state: string }).lifecycle_state;
    if (!['connected', 'healthy'].includes(lifecycle)) {
      return { status: 'unavailable' as const, reasonCode: 'activation_destination_unavailable' as const };
    }
    return { status: 'ready' as const, reasonCode: null };
  }

  private async setStatus(workspaceId: string, id: string, status: string) {
    await this.db.execute(sql`update radars set status=${status},paused_at=${status === 'paused' ? sql`now()` : null},archived_at=${status === 'archived' ? sql`now()` : null},updated_at=now() where workspace_id=${workspaceId} and id=${id}`);
  }
}
