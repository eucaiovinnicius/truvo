import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { ConnectorDestinationService } from '../connectors/connector-destination.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import {
  csvCell,
  decodeCursor,
  encodeCursor,
  normalizeQuery,
  OPPORTUNITY_POLICY,
  queryHash,
  type OpportunityFilters,
  type OpportunityQuery,
  type OpportunitySelection,
  type OpportunitySort,
  type SortDirection,
} from './opportunity-contracts';
import { VALUE_POLICY } from './opportunity-economics';
import { DecisionsService } from '../decisions/decisions.service';

export const band = (probability: number): 'high' | 'medium' | 'low' =>
  probability >= 0.75 ? 'high' : probability >= 0.5 ? 'medium' : 'low';

type SqlRow = Record<string, any>;

interface MaterializeOptions {
  failBeforePromotion?: boolean;
  /** Runtime-test seam at the transaction boundary; production callers omit it. */
  beforePromotion?: () => Promise<void>;
}

interface ListOptions extends OpportunityQuery {
  cursor?: string;
  limit?: number;
}

interface ExportInput {
  radarId: string;
  selection: OpportunitySelection;
  correlationId: string;
}

interface ActivationInput extends ExportInput {
  connectionId: string;
  idempotencyKey: string;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 26)}`;
}

function machineError(code: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message: code });
}

function assertDecimalFilter(value: string | undefined, code: string): void {
  if (value !== undefined && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) < 0)) throw machineError(code);
}

@Injectable()
export class OpportunitiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly connectorConnections: ConnectorConnectionService,
    private readonly connectorRegistry: ConnectorRegistryService,
    private readonly connectorDestination: ConnectorDestinationService,
    @Optional() private readonly decisions?: DecisionsService,
  ) {}

  /**
   * Serializes competing writers on the existing Radar row and keeps building
   * rows invisible until the final current-batch switch in the same transaction.
   */
  async materialize(workspaceId: string, radarId: string, reason = 'manual_refresh', options: MaterializeOptions = {}) {
    let auditMetadata: Record<string, unknown> | undefined;
    const result = await this.db.transaction(async (tx) => {
      const [source] = await tx.execute(sql`
        SELECT r.current_definition_version, m.id AS model_id, m.prediction_window_days,
               m.target_outcome_definition_id, b.scoring_cutoff, b.scored_customer_count
        FROM radars r
        JOIN radar_model_versions m
          ON m.workspace_id = r.workspace_id AND m.id = r.current_model_reference AND m.status = 'active'
        JOIN radar_score_batches b
          ON b.workspace_id = m.workspace_id AND b.radar_id = r.id
         AND b.model_version_id = m.id AND b.status = 'completed'
        WHERE r.workspace_id = ${workspaceId} AND r.id = ${radarId}
        ORDER BY b.scoring_cutoff DESC
        LIMIT 1
        FOR UPDATE OF r
      `) as SqlRow[];
      if (!source) throw machineError('waiting_for_scores');

      const [existing] = await tx.execute(sql`
        SELECT id, row_count, eligible_count, monetary_row_count
        FROM opportunity_batches
        WHERE workspace_id = ${workspaceId} AND radar_id = ${radarId}
          AND model_version_id = ${source.model_id} AND score_cutoff = ${source.scoring_cutoff}
          AND policy_version = ${OPPORTUNITY_POLICY.version} AND status = 'completed'
        LIMIT 1
      `) as SqlRow[];
      if (existing) return { id: existing.id, reused: true, rows: existing.row_count, eligible: existing.eligible_count, monetary: existing.monetary_row_count };

      const [scoreIntegrity] = await tx.execute(sql`
        SELECT count(*)::int AS total,
               count(DISTINCT customer_id)::int AS distinct_customers,
               count(*) FILTER (WHERE probability < 0 OR probability > 1)::int AS invalid_probability,
               count(*) FILTER (WHERE definition_version <> ${source.current_definition_version})::int AS invalid_definition
        FROM radar_propensity_scores
        WHERE workspace_id = ${workspaceId} AND radar_id = ${radarId}
          AND model_version_id = ${source.model_id} AND scoring_cutoff = ${source.scoring_cutoff}
      `) as SqlRow[];
      if (!scoreIntegrity
        || scoreIntegrity.total !== scoreIntegrity.distinct_customers
        || scoreIntegrity.total !== Number(source.scored_customer_count)
        || scoreIntegrity.invalid_probability > 0
        || scoreIntegrity.invalid_definition > 0) {
        throw machineError('corrupt_score_batch');
      }

      const id = `oppb_${ulid()}`;
      await tx.execute(sql`
        INSERT INTO opportunity_batches(
          workspace_id,id,radar_id,definition_version,model_version_id,score_cutoff,
          policy_version,trigger_reason
        ) VALUES (
          ${workspaceId},${id},${radarId},${source.current_definition_version},${source.model_id},
          ${source.scoring_cutoff},${OPPORTUNITY_POLICY.version},${reason}
        )
      `);

      let lastCustomerId: string | null = null;
      let insertedCount = 0;
      do {
        const inserted = await tx.execute(sql`
          WITH source_scores AS (
            SELECT s.*
            FROM radar_propensity_scores s
            WHERE s.workspace_id = ${workspaceId} AND s.radar_id = ${radarId}
              AND s.model_version_id = ${source.model_id} AND s.scoring_cutoff = ${source.scoring_cutoff}
              ${lastCustomerId ? sql`AND s.customer_id > ${lastCustomerId}` : sql``}
            ORDER BY s.customer_id ASC
            LIMIT ${OPPORTUNITY_POLICY.materializationChunkSize}
          )
          INSERT INTO opportunity_rows(
            workspace_id,id,batch_id,radar_id,customer_id,model_version_id,probability,
            score_band,scored_at,prediction_window_end,reason_codes,eligibility_state,
            expected_outcome_value,expected_revenue,currency,value_provenance
          )
          SELECT ${workspaceId}, 'oppr_' || substr(md5(${id} || s.customer_id),1,26), ${id}, ${radarId},
                 s.customer_id, ${source.model_id}, s.probability,
                 CASE WHEN s.probability >= .75 THEN 'high' WHEN s.probability >= .5 THEN 'medium' ELSE 'low' END,
                 s.scored_at, s.scoring_cutoff + (${source.prediction_window_days} || ' days')::interval,
                 s.reason_codes,
                 CASE WHEN c.deleted_at IS NOT NULL THEN 'suppressed'
                      WHEN c.status = 'merged' THEN 'stale_identity'
                      WHEN c.status = 'identified' THEN 'eligible' ELSE 'ineligible' END,
                 NULL,NULL,NULL,
                 jsonb_build_object(
                   'estimatorVersion', ${VALUE_POLICY.version}::text, 'lookbackDays', ${VALUE_POLICY.lookbackDays}::int,
                   'quality', 'unavailable', 'reason', 'insufficient_monetary_history'
                 )
          FROM source_scores s
          JOIN customers c ON c.workspace_id = s.workspace_id AND c.id = s.customer_id
          RETURNING customer_id
        `) as SqlRow[];
        insertedCount += inserted.length;
        lastCustomerId = inserted.length === OPPORTUNITY_POLICY.materializationChunkSize
          ? String(inserted[inserted.length - 1]!.customer_id)
          : null;
      } while (lastCustomerId);

      if (insertedCount !== scoreIntegrity.total) throw machineError('materialization_row_count_mismatch');
      await this.applyEconomics(tx as Database, workspaceId, id, source.target_outcome_definition_id);

      const [counts] = await tx.execute(sql`
        SELECT count(*)::int AS rows,
               count(*) FILTER (WHERE eligibility_state = 'eligible')::int AS eligible,
               count(*) FILTER (WHERE eligibility_state = 'eligible' AND expected_revenue IS NOT NULL)::int AS monetary,
               count(DISTINCT currency) FILTER (WHERE eligibility_state = 'eligible' AND currency IS NOT NULL)::int AS currencies,
               sum(expected_revenue) FILTER (WHERE eligibility_state = 'eligible') AS expected_revenue,
               max(currency) FILTER (WHERE eligibility_state = 'eligible') AS only_currency
        FROM opportunity_rows WHERE workspace_id = ${workspaceId} AND batch_id = ${id}
      `) as SqlRow[];
      if (!counts || counts.rows !== insertedCount) throw machineError('materialization_validation_failed');
      await options.beforePromotion?.();
      if (options.failBeforePromotion) throw new Error('forced_failure_before_promotion');

      // Order matters: the unique partial index is never violated and no building
      // batch is visible as current.
      await tx.execute(sql`
        UPDATE opportunity_batches SET is_current = 0
        WHERE workspace_id = ${workspaceId} AND radar_id = ${radarId} AND is_current = 1
      `);
      await tx.execute(sql`
        UPDATE opportunity_batches
        SET status = 'completed', is_current = 1, row_count = ${counts.rows},
            eligible_count = ${counts.eligible}, monetary_row_count = ${counts.monetary},
            aggregate_expected_revenue = CASE WHEN ${counts.currencies}::int = 1 THEN ${counts.expected_revenue}::numeric ELSE NULL END,
            aggregate_currency = CASE WHEN ${counts.currencies}::int = 1 THEN ${counts.only_currency}::text ELSE NULL END,
            materialized_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'building'
      `);
      auditMetadata = { radarId, reason, rowCount: counts.rows, eligibleCount: counts.eligible, monetaryCount: counts.monetary };
      return { id, reused: false, rows: counts.rows, eligible: counts.eligible, monetary: counts.monetary };
    });

    if (auditMetadata) {
      await this.audit.record({
        workspaceId,
        actorType: 'system',
        category: 'opportunity',
        action: 'opportunity.materialized',
        resourceType: 'opportunity_batch',
        resourceId: result.id,
        metadata: auditMetadata,
      });
    }
    return result;
  }

  private async applyEconomics(db: Database, workspaceId: string, batchId: string, targetOutcomeDefinitionId: string): Promise<void> {
    await db.execute(sql`
      WITH valid AS (
        SELECT o.customer_id, upper(o.currency) AS currency, o.value::numeric AS value, o.id,
               count(*) OVER (PARTITION BY o.customer_id, upper(o.currency)) AS currency_n,
               row_number() OVER (PARTITION BY o.customer_id, upper(o.currency) ORDER BY o.value::numeric, o.id) AS currency_rank
        FROM customer_outcomes o
        JOIN opportunity_batches b ON b.workspace_id = o.workspace_id AND b.id = ${batchId}
        WHERE o.workspace_id = ${workspaceId}
          AND o.outcome_definition_id = ${targetOutcomeDefinitionId}
          AND o.deleted_at IS NULL
          AND o.observed_at >= b.score_cutoff - (${VALUE_POLICY.lookbackDays} || ' days')::interval
          AND o.observed_at <= b.score_cutoff
          AND o.value IS NOT NULL AND o.value > 0
          AND o.currency ~ '^[A-Za-z]{3}$'
      ), customer_meta AS (
        SELECT customer_id, count(DISTINCT currency)::int AS currency_count, count(*)::int AS sample_count
        FROM valid GROUP BY customer_id
      ), customer_estimates AS (
        SELECT customer_id, currency, max(currency_n)::int AS sample_count,
               avg(value) FILTER (
                 WHERE currency_rank > CASE WHEN currency_n >= ${VALUE_POLICY.minimumTrimmedSampleSize}
                   THEN greatest(1, floor(currency_n * ${VALUE_POLICY.trimFraction}::numeric)::int) ELSE 0 END
                   AND currency_rank <= currency_n - CASE WHEN currency_n >= ${VALUE_POLICY.minimumTrimmedSampleSize}
                   THEN greatest(1, floor(currency_n * ${VALUE_POLICY.trimFraction}::numeric)::int) ELSE 0 END
               ) AS estimate
        FROM valid GROUP BY customer_id, currency
        HAVING max(currency_n) >= ${VALUE_POLICY.customerMinimumSamples}
      ), cohort_meta AS (
        SELECT count(DISTINCT currency)::int AS currency_count, count(*)::int AS sample_count FROM valid
      ), cohort_ranked AS (
        SELECT currency, value, id, count(*) OVER (PARTITION BY currency) AS currency_n,
               row_number() OVER (PARTITION BY currency ORDER BY value, id) AS currency_rank
        FROM valid
      ), cohort_estimates AS (
        SELECT currency, max(currency_n)::int AS sample_count,
               avg(value) FILTER (
                 WHERE currency_rank > greatest(1, floor(currency_n * ${VALUE_POLICY.trimFraction}::numeric)::int)
                   AND currency_rank <= currency_n - greatest(1, floor(currency_n * ${VALUE_POLICY.trimFraction}::numeric)::int)
               ) AS estimate
        FROM cohort_ranked GROUP BY currency
        HAVING max(currency_n) >= ${VALUE_POLICY.cohortMinimumSamples}
      ), resolved AS (
        SELECT opportunity.workspace_id, opportunity.id,
          CASE WHEN customer_meta.currency_count = 1 AND customer_estimates.estimate IS NOT NULL THEN customer_estimates.estimate
               WHEN coalesce(customer_meta.currency_count, 0) <= 1 AND cohort_meta.currency_count = 1 THEN cohort_estimates.estimate
               ELSE NULL END AS estimate,
          CASE WHEN customer_meta.currency_count = 1 AND customer_estimates.estimate IS NOT NULL THEN customer_estimates.currency
               WHEN coalesce(customer_meta.currency_count, 0) <= 1 AND cohort_meta.currency_count = 1 THEN cohort_estimates.currency
               ELSE NULL END AS currency,
          CASE WHEN customer_meta.currency_count = 1 AND customer_estimates.estimate IS NOT NULL THEN 'customer'
               WHEN coalesce(customer_meta.currency_count, 0) <= 1 AND cohort_meta.currency_count = 1 AND cohort_estimates.estimate IS NOT NULL THEN 'cohort'
               ELSE 'unavailable' END AS estimate_source,
          CASE WHEN customer_meta.currency_count = 1 AND customer_estimates.estimate IS NOT NULL THEN customer_estimates.sample_count
               WHEN coalesce(customer_meta.currency_count, 0) <= 1 AND cohort_meta.currency_count = 1 THEN cohort_estimates.sample_count
               ELSE coalesce(customer_meta.sample_count, 0) END AS sample_count,
          CASE WHEN customer_meta.currency_count > 1 THEN 'mixed_currency' ELSE 'insufficient_monetary_history' END AS unavailable_reason
        FROM opportunity_rows opportunity
        LEFT JOIN customer_meta ON customer_meta.customer_id = opportunity.customer_id
        LEFT JOIN customer_estimates ON customer_estimates.customer_id = opportunity.customer_id AND customer_meta.currency_count = 1
        CROSS JOIN cohort_meta
        LEFT JOIN cohort_estimates ON cohort_meta.currency_count = 1
        WHERE opportunity.workspace_id = ${workspaceId} AND opportunity.batch_id = ${batchId}
      )
      UPDATE opportunity_rows opportunity
      SET expected_outcome_value = resolved.estimate,
          expected_revenue = opportunity.probability * resolved.estimate,
          currency = resolved.currency,
          value_provenance = CASE WHEN resolved.estimate IS NULL THEN jsonb_build_object(
            'estimatorVersion', ${VALUE_POLICY.version}::text, 'source', 'unavailable',
            'sampleCount', resolved.sample_count, 'lookbackDays', ${VALUE_POLICY.lookbackDays}::int,
            'estimatedAt', now(), 'quality', 'unavailable', 'reason', resolved.unavailable_reason
          ) ELSE jsonb_build_object(
            'estimatorVersion', ${VALUE_POLICY.version}::text, 'source', resolved.estimate_source,
            'sampleCount', resolved.sample_count, 'lookbackDays', ${VALUE_POLICY.lookbackDays}::int,
            'estimatedAt', now(), 'quality', CASE
              WHEN resolved.estimate_source = 'customer' AND resolved.sample_count >= 5 THEN 'high'
              WHEN resolved.estimate_source = 'customer' THEN 'medium'
              WHEN resolved.sample_count >= 100 THEN 'medium' ELSE 'low' END
          ) END
      FROM resolved
      WHERE opportunity.workspace_id = resolved.workspace_id AND opportunity.id = resolved.id
    `);
  }

  async reconcile(workspaceId: string, radarId: string) {
    const [state] = await this.db.execute(sql`
      SELECT r.id AS radar_id, r.current_definition_version, r.current_model_reference,
             m.status AS model_status,
             score.model_version_id AS score_model_id, score.scoring_cutoff,
             current_batch.id AS batch_id, current_batch.model_version_id AS batch_model_id,
             current_batch.score_cutoff AS batch_score_cutoff, current_batch.materialized_at,
             failed.status AS failed_status,
             EXISTS (
               SELECT 1 FROM opportunity_rows opportunity
               JOIN customers customer ON customer.workspace_id = opportunity.workspace_id AND customer.id = opportunity.customer_id
               WHERE opportunity.workspace_id = r.workspace_id AND opportunity.batch_id = current_batch.id
                 AND opportunity.eligibility_state = 'eligible'
                 AND (customer.deleted_at IS NOT NULL OR customer.status <> 'identified')
             ) AS stale_identity
      FROM radars r
      LEFT JOIN radar_model_versions m ON m.workspace_id = r.workspace_id AND m.id = r.current_model_reference
      LEFT JOIN LATERAL (
        SELECT b.model_version_id, b.scoring_cutoff FROM radar_score_batches b
        WHERE b.workspace_id = r.workspace_id AND b.radar_id = r.id
          AND b.model_version_id = r.current_model_reference AND b.status = 'completed'
        ORDER BY b.scoring_cutoff DESC LIMIT 1
      ) score ON true
      LEFT JOIN opportunity_batches current_batch
        ON current_batch.workspace_id = r.workspace_id AND current_batch.radar_id = r.id
       AND current_batch.is_current = 1 AND current_batch.status = 'completed'
      LEFT JOIN LATERAL (
        SELECT status FROM opportunity_batches candidate
        WHERE candidate.workspace_id = r.workspace_id AND candidate.radar_id = r.id AND candidate.status = 'failed'
        ORDER BY candidate.created_at DESC LIMIT 1
      ) failed ON true
      WHERE r.workspace_id = ${workspaceId} AND r.id = ${radarId}
    `) as SqlRow[];
    if (!state) throw new NotFoundException('Radar not found');
    if (!state.current_model_reference) return { state: 'no_active_model' as const };
    if (state.model_status !== 'active') return { state: 'stale_model' as const };
    if (!state.score_model_id) return { state: 'waiting_for_scores' as const };
    if (state.failed_status && !state.batch_id) return { state: 'materialization_failed' as const };
    if (!state.batch_id) return { state: 'needs_materialization' as const };
    if (state.batch_model_id !== state.current_model_reference) return { state: 'waiting_for_scores' as const };
    if (new Date(state.batch_score_cutoff).getTime() !== new Date(state.scoring_cutoff).getTime()) return { state: 'needs_materialization' as const, batchId: state.batch_id };
    if (state.stale_identity) return { state: 'stale_identity' as const, batchId: state.batch_id };
    const ageHours = (Date.now() - new Date(state.materialized_at).getTime()) / 3_600_000;
    if (ageHours >= OPPORTUNITY_POLICY.refreshIntervalHours) return { state: 'eligibility_refresh_due' as const, batchId: state.batch_id };
    return { state: 'ready' as const, batchId: state.batch_id };
  }

  async summary(workspaceId: string, radarId: string) {
    const reconciliation = await this.reconcile(workspaceId, radarId);
    if (!('batchId' in reconciliation)) return { state: reconciliation.state };
    const [batch] = await this.db.execute(sql`
      SELECT b.*, r.name AS radar_name, m.prediction_window_days, m.status AS model_status,
             d.outcome_definition_id
      FROM opportunity_batches b
      JOIN radars r ON r.workspace_id = b.workspace_id AND r.id = b.radar_id
      JOIN radar_model_versions m ON m.workspace_id = b.workspace_id AND m.id = b.model_version_id
      JOIN radar_definition_versions d ON d.workspace_id = b.workspace_id AND d.radar_id = b.radar_id AND d.version = b.definition_version
      WHERE b.workspace_id = ${workspaceId} AND b.id = ${reconciliation.batchId}
    `) as SqlRow[];
    const [counts] = await this.db.execute(sql`
      SELECT count(*) FILTER (WHERE eligibility_state = 'eligible')::int AS opportunity_count,
             count(*) FILTER (WHERE eligibility_state = 'eligible' AND expected_revenue IS NOT NULL)::int AS monetary_count,
             count(*) FILTER (WHERE eligibility_state = 'eligible' AND score_band = 'high')::int AS high,
             count(*) FILTER (WHERE eligibility_state = 'eligible' AND score_band = 'medium')::int AS medium,
             count(*) FILTER (WHERE eligibility_state = 'eligible' AND score_band = 'low')::int AS low
      FROM opportunity_rows WHERE workspace_id = ${workspaceId} AND batch_id = ${reconciliation.batchId}
    `) as SqlRow[];
    const currencyTotals = await this.db.execute(sql`
      SELECT currency, sum(expected_revenue) AS expected_revenue
      FROM opportunity_rows
      WHERE workspace_id = ${workspaceId} AND batch_id = ${reconciliation.batchId}
        AND eligibility_state = 'eligible' AND expected_revenue IS NOT NULL
      GROUP BY currency ORDER BY currency
    `) as SqlRow[];
    const opportunityCount = counts?.opportunity_count ?? 0;
    return {
      state: reconciliation.state,
      provenance: this.provenance(batch!),
      summary: {
        opportunityCount,
        monetaryOpportunityCount: counts?.monetary_count ?? 0,
        monetaryCoverageRatio: opportunityCount ? (counts?.monetary_count ?? 0) / opportunityCount : 0,
        bands: { high: counts?.high ?? 0, medium: counts?.medium ?? 0, low: counts?.low ?? 0 },
        expectedRevenue: currencyTotals.length === 1 ? currencyTotals[0] : null,
        expectedRevenueByCurrency: currencyTotals,
        currencyState: currencyTotals.length > 1 ? 'mixed' : currencyTotals.length === 1 ? 'single' : 'unavailable',
      },
    };
  }

  async list(workspaceId: string, radarId: string, options: ListOptions = {}) {
    const query = this.normalizedQuery(options);
    const reconciliation = await this.reconcile(workspaceId, radarId);
    if (['no_active_model', 'waiting_for_scores', 'stale_model', 'materialization_failed'].includes(reconciliation.state)) {
      return { items: [], nextCursor: null, state: reconciliation.state, query };
    }
    const [batch] = await this.db.execute(sql`
      SELECT b.*, r.name AS radar_name, m.prediction_window_days, m.status AS model_status,
             d.outcome_definition_id
      FROM opportunity_batches b
      JOIN radars r ON r.workspace_id = b.workspace_id AND r.id = b.radar_id
      JOIN radar_model_versions m ON m.workspace_id = b.workspace_id AND m.id = b.model_version_id
      JOIN radar_definition_versions d ON d.workspace_id = b.workspace_id AND d.radar_id = b.radar_id AND d.version = b.definition_version
      WHERE b.workspace_id = ${workspaceId} AND b.radar_id = ${radarId}
        AND b.is_current = 1 AND b.status = 'completed'
    `) as SqlRow[];
    if (!batch) return { items: [], state: reconciliation.state };

    let effectiveSort = query.sort;
    if (query.sort === 'expectedRevenue' && !query.filters.currency && !batch.aggregate_currency) {
      if (options.sort === 'expectedRevenue' && Number(batch.monetary_row_count) > 0) throw machineError('mixed_currency_requires_currency_filter');
      effectiveSort = 'probability';
    }
    if ((query.filters.expectedRevenueMin !== undefined || query.filters.expectedRevenueMax !== undefined) && !query.filters.currency && !batch.aggregate_currency) {
      throw machineError('mixed_currency_requires_currency_filter');
    }

    const limit = Math.min(Math.max(options.limit ?? OPPORTUNITY_POLICY.defaultPageSize, 1), OPPORTUNITY_POLICY.maxPageSize);
    const hash = queryHash({ sort: effectiveSort, direction: query.direction, filters: query.filters });
    let cursorCondition = sql``;
    if (options.cursor) {
      let decoded;
      try { decoded = decodeCursor(options.cursor); } catch { throw machineError('invalid_cursor'); }
      if (decoded.workspaceId !== workspaceId || decoded.radarId !== radarId || decoded.batchId !== batch.id
        || decoded.sort !== effectiveSort || decoded.direction !== query.direction || decoded.queryHash !== hash) {
        throw machineError('stale_cursor');
      }
      cursorCondition = this.cursorSql(effectiveSort, query.direction, decoded.sortValue, decoded.secondaryValue, decoded.id);
    }
    const filters = this.filtersSql(query.filters);
    const order = this.orderSql(effectiveSort, query.direction);
    const rows = await this.db.execute(sql`
      SELECT opportunity.id, opportunity.customer_id, opportunity.radar_id, opportunity.model_version_id,
             opportunity.eligibility_state, opportunity.probability, opportunity.score_band,
             opportunity.expected_outcome_value, opportunity.expected_revenue, opportunity.currency,
             opportunity.value_provenance, opportunity.reason_codes, opportunity.scored_at,
             opportunity.prediction_window_end, customer.last_seen_at AS recent_activity,
             customer.status AS customer_status, customer.deleted_at AS customer_deleted_at
      FROM opportunity_rows opportunity
      JOIN customers customer ON customer.workspace_id = opportunity.workspace_id AND customer.id = opportunity.customer_id
      WHERE opportunity.workspace_id = ${workspaceId} AND opportunity.batch_id = ${batch.id}
        AND opportunity.eligibility_state = 'eligible' AND customer.status = 'identified' AND customer.deleted_at IS NULL
        ${filters} ${cursorCondition}
      ${order}
      LIMIT ${limit + 1}
    `) as SqlRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1,
      workspaceId,
      radarId,
      batchId: batch.id,
      sort: effectiveSort,
      direction: query.direction,
      sortValue: this.sortValue(last, effectiveSort),
      secondaryValue: effectiveSort === 'expectedRevenue' ? String(last.probability) : null,
      id: last.id,
      queryHash: hash,
    }) : null;
    return { state: 'current', items, nextCursor, query: { ...query, sort: effectiveSort }, provenance: this.provenance(batch) };
  }

  async detail(workspaceId: string, id: string) {
    const [row] = await this.db.execute(sql`
      SELECT opportunity.*, batch.is_current, batch.materialized_at, batch.definition_version,
             batch.score_cutoff, radar.name AS radar_name, model.prediction_window_days,
             customer.last_seen_at AS recent_activity, customer.status AS customer_status,
             customer.deleted_at AS customer_deleted_at
      FROM opportunity_rows opportunity
      JOIN opportunity_batches batch ON batch.workspace_id = opportunity.workspace_id AND batch.id = opportunity.batch_id
      JOIN radars radar ON radar.workspace_id = opportunity.workspace_id AND radar.id = opportunity.radar_id
      JOIN radar_model_versions model ON model.workspace_id = opportunity.workspace_id AND model.id = opportunity.model_version_id
      JOIN customers customer ON customer.workspace_id = opportunity.workspace_id AND customer.id = opportunity.customer_id
      WHERE opportunity.workspace_id = ${workspaceId} AND opportunity.id = ${id}
        AND customer.deleted_at IS NULL
    `) as SqlRow[];
    if (!row) throw new NotFoundException('Opportunity not found');
    return {
      ...row,
      eligibility_state: row.customer_status === 'identified' ? row.eligibility_state : 'stale_identity',
      provenance: {
        radarId: row.radar_id,
        radarDefinitionVersion: row.definition_version,
        modelVersionId: row.model_version_id,
        opportunityBatchId: row.batch_id,
        scoreCutoff: row.score_cutoff,
        scoredAt: row.scored_at,
        materializedAt: row.materialized_at,
        predictionWindowDays: row.prediction_window_days,
      },
    };
  }

  async backfillExistingScores(workspaceId: string, limit = 10) {
    const candidates = await this.db.execute(sql`
      SELECT r.id
      FROM radars r
      JOIN radar_model_versions m ON m.workspace_id = r.workspace_id AND m.id = r.current_model_reference AND m.status = 'active'
      JOIN LATERAL (
        SELECT b.scoring_cutoff FROM radar_score_batches b
        WHERE b.workspace_id = r.workspace_id AND b.radar_id = r.id AND b.model_version_id = m.id AND b.status = 'completed'
        ORDER BY b.scoring_cutoff DESC LIMIT 1
      ) score ON true
      WHERE r.workspace_id = ${workspaceId}
        AND NOT EXISTS (
          SELECT 1 FROM opportunity_batches opportunity
          WHERE opportunity.workspace_id = r.workspace_id AND opportunity.radar_id = r.id
            AND opportunity.model_version_id = m.id AND opportunity.score_cutoff = score.scoring_cutoff
            AND opportunity.policy_version = ${OPPORTUNITY_POLICY.version} AND opportunity.status = 'completed'
        )
      ORDER BY r.id LIMIT ${Math.min(Math.max(limit, 1), 100)}
    `) as SqlRow[];
    let materialized = 0;
    const failures: Array<{ radarId: string; error: string }> = [];
    for (const candidate of candidates) {
      try {
        await this.materialize(workspaceId, candidate.id, 'existing_score_backfill');
        materialized += 1;
      } catch (error) {
        failures.push({ radarId: candidate.id, error: (error as Error).message });
      }
    }
    return { discovered: candidates.length, materialized, failed: failures.length, failures };
  }

  async sweepWorkspace(workspaceId: string) {
    const radars = await this.db.execute(sql`
      SELECT id FROM radars WHERE workspace_id = ${workspaceId} AND archived_at IS NULL ORDER BY id
    `) as SqlRow[];
    const result = { inspected: radars.length, materialized: 0, unchanged: 0, waiting: 0, failed: 0 };
    for (const radar of radars) {
      try {
        const state = await this.reconcile(workspaceId, radar.id);
        if (['needs_materialization', 'eligibility_refresh_due', 'materialization_failed', 'stale_identity'].includes(state.state)) {
          await this.materialize(workspaceId, radar.id, `scheduler_${state.state}`);
          result.materialized += 1;
        } else if (state.state === 'waiting_for_scores' || state.state === 'no_active_model') result.waiting += 1;
        else result.unchanged += 1;
      } catch { result.failed += 1; }
    }
    return result;
  }

  async exportCsv(workspaceId: string, actorUserId: string | undefined, input: ExportInput) {
    if (!input.correlationId?.trim()) throw machineError('missing_correlation_id');
    const rows = await this.selectionRows(workspaceId, input.radarId, input.selection);
    const [batch] = await this.requireCurrentBatch(workspaceId, input.radarId, input.selection.batchId);
    const exportId = deterministicId('opex', workspaceId, input.correlationId);
    await this.db.execute(sql`
      INSERT INTO opportunity_exports(
        workspace_id,id,radar_id,batch_id,model_version_id,actor_user_id,correlation_id,selection,status,row_count
      ) VALUES (
        ${workspaceId},${exportId},${input.radarId},${batch.id},${batch.model_version_id},${actorUserId ?? null},
        ${input.correlationId},${JSON.stringify(input.selection)}::jsonb,'pending',0
      ) ON CONFLICT (workspace_id,correlation_id) DO NOTHING
    `);
    const header = [
      'customer_id', 'probability', 'band', 'expected_outcome_value', 'expected_revenue', 'currency',
      'prediction_window_end', 'signals', 'radar_id', 'model_version_id', 'scored_at', 'materialized_at', 'opportunity_batch_id',
    ];
    const body = rows.map((row) => [
      csvCell(row.customer_id), csvCell(row.probability, true), csvCell(row.score_band),
      csvCell(row.expected_outcome_value, true), csvCell(row.expected_revenue, true), csvCell(row.currency),
      csvCell(new Date(row.prediction_window_end).toISOString()), csvCell(JSON.stringify(row.reason_codes)),
      csvCell(row.radar_id), csvCell(row.model_version_id), csvCell(new Date(row.scored_at).toISOString()),
      csvCell(new Date(batch.materialized_at).toISOString()), csvCell(batch.id),
    ].join(','));
    const csv = `\uFEFF${header.join(',')}\r\n${body.join('\r\n')}\r\n`;
    await this.db.execute(sql`
      UPDATE opportunity_exports SET status = 'completed', row_count = ${rows.length}, completed_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${exportId}
    `);
    await this.audit.record({
      workspaceId, actorUserId, category: 'opportunity', action: 'opportunity.exported',
      resourceType: 'opportunity_export', resourceId: exportId,
      metadata: { radarId: input.radarId, batchId: batch.id, modelVersionId: batch.model_version_id, correlationId: input.correlationId, rowCount: rows.length },
    });
    return { id: exportId, rowCount: rows.length, csv };
  }

  async previewActivation(workspaceId: string, input: ActivationInput) {
    const rows = await this.selectionRows(workspaceId, input.radarId, input.selection, true);
    const [batch] = await this.requireCurrentBatch(workspaceId, input.radarId, input.selection.batchId);
    const destination = { ...(await this.destinationState(workspaceId, input.connectionId)), definitionVersion: batch.definition_version };
    const identifiers = await this.identifiersFor(workspaceId, rows.map((row) => row.customer_id));
    const seen = new Set<string>();
    let suppressed = 0;
    let missingDestinationIdentifier = 0;
    let duplicatesCollapsed = 0;
    const deliverable: SqlRow[] = [];
    for (const row of rows) {
      if (row.customer_deleted_at || row.customer_status !== 'identified' || row.eligibility_state !== 'eligible') { suppressed += 1; continue; }
      const identifier = identifiers.get(row.customer_id);
      if (!identifier) { missingDestinationIdentifier += 1; continue; }
      if (seen.has(identifier.value)) { duplicatesCollapsed += 1; continue; }
      seen.add(identifier.value);
      deliverable.push({ ...row, destinationIdentifier: identifier });
    }
    return {
      providerMutation: false,
      opportunityBatchId: batch.id,
      modelVersionId: batch.model_version_id,
      destination,
      counts: {
        requested: rows.length,
        currentlyEligible: rows.length - suppressed,
        suppressed,
        missingDestinationIdentifier,
        duplicatesCollapsed,
        deliverable: deliverable.length,
      },
      exclusions: { suppressed, missingDestinationIdentifier, duplicatesCollapsed },
      deliverable,
    };
  }

  async activate(workspaceId: string, actorUserId: string | undefined, input: ActivationInput) {
    if (!input.idempotencyKey?.trim() || !input.correlationId?.trim()) throw machineError('missing_activation_identity');
    const [replay] = await this.db.execute(sql`
      SELECT * FROM opportunity_activations WHERE workspace_id = ${workspaceId} AND idempotency_key = ${input.idempotencyKey}
    `) as SqlRow[];
    if (replay) return { replay: true, id: replay.id, status: replay.status, counts: replay.counts, remoteAudienceId: replay.remote_audience_id };

    const preview = await this.previewActivation(workspaceId, input);
    if (preview.destination.status !== 'ready') throw machineError('destination_disconnected');
    const activationId = deterministicId('opac', workspaceId, input.idempotencyKey);
    const decisions = this.decisions ? await this.decisions.createForOpportunity(workspaceId, preview.deliverable, { radarId: input.radarId, connectionId: input.connectionId, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey }) : [];
    await this.db.execute(sql`
      INSERT INTO opportunity_activations(
        workspace_id,id,radar_id,definition_version,model_version_id,batch_id,connection_id,
        correlation_id,idempotency_key,selection,counts,status
      ) VALUES (
        ${workspaceId},${activationId},${input.radarId},${preview.destination.definitionVersion},
        ${preview.modelVersionId},${preview.opportunityBatchId},${input.connectionId},${input.correlationId},
        ${input.idempotencyKey},${JSON.stringify(input.selection)}::jsonb,${JSON.stringify(preview.counts)}::jsonb,'pending'
      )
    `);

    // Re-check canonical privacy state immediately before each provider write.
    let attempted = 0;
    let accepted = 0;
    let providerRejected = 0;
    let retryableFailures = 0;
    let permanentFailures = 0;
    let suppressedAfterPreview = 0;
    let remoteAudienceId: string | undefined;
    for (let offset = 0; offset < preview.deliverable.length; offset += OPPORTUNITY_POLICY.activationChunkSize) {
      const candidateChunk = preview.deliverable.slice(offset, offset + OPPORTUNITY_POLICY.activationChunkSize);
      const freshRows = await this.db.execute(sql`
        SELECT id FROM customers
        WHERE workspace_id = ${workspaceId} AND id IN (${sql.join(candidateChunk.map((row) => sql`${row.customer_id}`), sql`,`)})
          AND status = 'identified' AND deleted_at IS NULL
      `) as SqlRow[];
      const allowed = new Set(freshRows.map((row) => row.id));
      const chunk = candidateChunk.filter((row) => allowed.has(row.customer_id));
      suppressedAfterPreview += candidateChunk.length - chunk.length;
      if (!chunk.length) continue;
      attempted += chunk.length;
      const write = await this.connectorDestination.write(workspaceId, input.connectionId, {
        idempotencyKey: `${input.idempotencyKey}:${offset / OPPORTUNITY_POLICY.activationChunkSize}`,
        correlationId: input.correlationId,
        kind: 'audience_upsert',
        payload: {
          activationId,
          opportunityBatchId: preview.opportunityBatchId,
          members: chunk.map((row) => ({ customerId: row.customer_id, identifier: row.destinationIdentifier })),
        },
      });
      if (write.status === 'sent') {
        accepted += chunk.length;
        remoteAudienceId ??= write.externalResultId;
      } else {
        providerRejected += chunk.length;
        if (write.retryable) retryableFailures += chunk.length;
        else permanentFailures += chunk.length;
      }
    }
    const excluded = preview.counts.requested - preview.counts.deliverable + suppressedAfterPreview;
    const counts = { ...preview.counts, attempted, accepted, excluded, providerRejected, retryableFailures, permanentFailures, suppressedAfterPreview };
    const status = accepted === attempted && attempted > 0 ? 'success' : accepted > 0 ? 'partial' : 'failed';
    await this.db.execute(sql`
      UPDATE opportunity_activations SET status = ${status}, counts = ${JSON.stringify(counts)}::jsonb,
        remote_audience_id = ${remoteAudienceId ?? null}, completed_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${activationId}
    `);
    await this.audit.record({
      workspaceId, actorUserId, category: 'opportunity', action: 'opportunity.audience_activated',
      resourceType: 'opportunity_activation', resourceId: activationId,
      metadata: { radarId: input.radarId, modelVersionId: preview.modelVersionId, opportunityBatchId: preview.opportunityBatchId, connectionId: input.connectionId, correlationId: input.correlationId, status, counts },
    });
    if (this.decisions) await this.decisions.recordExecution(workspaceId, decisions.map((decision) => decision.id), { connectionId: input.connectionId, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey, status: status === 'success' ? 'succeeded' : status === 'partial' ? 'partially_succeeded' : 'failed', remoteId: remoteAudienceId, counts });
    return { replay: false, id: activationId, status, counts, remoteAudienceId, decisionBatchId: decisions[0] ? `dcb_${createHash('sha256').update([workspaceId,input.idempotencyKey].join('\u001f')).digest('hex').slice(0,26)}` : undefined, decisionCount: decisions.length };
  }

  private normalizedQuery(options: OpportunityQuery) {
    try {
      const query = normalizeQuery(options);
      assertDecimalFilter(query.filters.expectedRevenueMin, 'invalid_expected_revenue_min');
      assertDecimalFilter(query.filters.expectedRevenueMax, 'invalid_expected_revenue_max');
      if (query.filters.recentActivityAfter && Number.isNaN(Date.parse(query.filters.recentActivityAfter))) throw machineError('invalid_recent_activity');
      return query;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw machineError((error as Error).message);
    }
  }

  private filtersSql(filters: OpportunityFilters): SQL {
    const conditions: SQL[] = [];
    if (filters.scoreBands?.length) conditions.push(sql`opportunity.score_band IN (${sql.join(filters.scoreBands.map((value) => sql`${value}`), sql`,`)})`);
    if (filters.probabilityMin !== undefined) conditions.push(sql`opportunity.probability >= ${filters.probabilityMin}`);
    if (filters.probabilityMax !== undefined) conditions.push(sql`opportunity.probability <= ${filters.probabilityMax}`);
    if (filters.monetary === true) conditions.push(sql`opportunity.expected_revenue IS NOT NULL`);
    if (filters.monetary === false) conditions.push(sql`opportunity.expected_revenue IS NULL`);
    if (filters.currency) conditions.push(sql`opportunity.currency = ${filters.currency}`);
    if (filters.expectedRevenueMin !== undefined) conditions.push(sql`opportunity.expected_revenue >= ${filters.expectedRevenueMin}::numeric`);
    if (filters.expectedRevenueMax !== undefined) conditions.push(sql`opportunity.expected_revenue <= ${filters.expectedRevenueMax}::numeric`);
    if (filters.recentActivityAfter) conditions.push(sql`customer.last_seen_at >= ${filters.recentActivityAfter}::timestamptz`);
    if (filters.trait) conditions.push(sql`EXISTS (
      SELECT 1 FROM customer_traits trait
      WHERE trait.workspace_id = opportunity.workspace_id AND trait.customer_id = opportunity.customer_id
        AND trait.trait_namespace = ${filters.trait.namespace} AND trait.trait_key = ${filters.trait.key}
        AND trait.deleted_at IS NULL AND trait.value = ${JSON.stringify(filters.trait.value)}::jsonb
    )`);
    return conditions.length ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;
  }

  private orderSql(sort: OpportunitySort, direction: SortDirection): SQL {
    const dir = direction === 'asc' ? sql`ASC` : sql`DESC`;
    if (sort === 'expectedRevenue') return sql`ORDER BY (opportunity.expected_revenue IS NULL) ASC, opportunity.expected_revenue ${dir}, opportunity.probability DESC, opportunity.id ASC`;
    if (sort === 'recentActivity') return sql`ORDER BY customer.last_seen_at ${dir}, opportunity.id ASC`;
    return sql`ORDER BY opportunity.probability ${dir}, opportunity.id ASC`;
  }

  private cursorSql(sort: OpportunitySort, direction: SortDirection, value: string | null, secondary: string | null, id: string): SQL {
    const comparison = direction === 'asc' ? sql`>` : sql`<`;
    if (sort === 'expectedRevenue') {
      if (value === null) return sql`AND opportunity.expected_revenue IS NULL AND (opportunity.probability < ${secondary}::numeric OR (opportunity.probability = ${secondary}::numeric AND opportunity.id > ${id}))`;
      return sql`AND (
        opportunity.expected_revenue IS NULL
        OR opportunity.expected_revenue ${comparison} ${value}::numeric
        OR (opportunity.expected_revenue = ${value}::numeric AND opportunity.probability < ${secondary}::numeric)
        OR (opportunity.expected_revenue = ${value}::numeric AND opportunity.probability = ${secondary}::numeric AND opportunity.id > ${id})
      )`;
    }
    if (sort === 'recentActivity') return sql`AND (customer.last_seen_at ${comparison} ${value}::timestamptz OR (customer.last_seen_at = ${value}::timestamptz AND opportunity.id > ${id}))`;
    return sql`AND (opportunity.probability ${comparison} ${value}::numeric OR (opportunity.probability = ${value}::numeric AND opportunity.id > ${id}))`;
  }

  private sortValue(row: SqlRow, sort: OpportunitySort): string | null {
    if (sort === 'expectedRevenue') return row.expected_revenue === null ? null : String(row.expected_revenue);
    if (sort === 'recentActivity') return new Date(row.recent_activity).toISOString();
    return String(row.probability);
  }

  private provenance(batch: SqlRow) {
    const materializedAt = new Date(batch.materialized_at);
    return {
      radarId: batch.radar_id,
      radarName: batch.radar_name,
      radarDefinitionVersion: batch.definition_version,
      modelVersionId: batch.model_version_id,
      scoreBatch: { modelVersionId: batch.model_version_id, scoreCutoff: batch.score_cutoff },
      opportunityBatchId: batch.id,
      scoreCutoff: batch.score_cutoff,
      materializedAt: batch.materialized_at,
      predictionWindowDays: batch.prediction_window_days,
      freshness: (Date.now() - materializedAt.getTime()) / 3_600_000 < OPPORTUNITY_POLICY.refreshIntervalHours ? 'current' : 'refresh_due',
    };
  }

  private async requireCurrentBatch(workspaceId: string, radarId: string, batchId: string): Promise<SqlRow[]> {
    const rows = await this.db.execute(sql`
      SELECT b.*, d.activation_destination, d.version AS definition_version
      FROM opportunity_batches b
      JOIN radar_definition_versions d ON d.workspace_id = b.workspace_id AND d.radar_id = b.radar_id AND d.version = b.definition_version
      WHERE b.workspace_id = ${workspaceId} AND b.radar_id = ${radarId} AND b.id = ${batchId}
        AND b.is_current = 1 AND b.status = 'completed'
    `) as SqlRow[];
    if (!rows[0]) throw machineError('stale_selection');
    return rows;
  }

  private async selectionRows(workspaceId: string, radarId: string, selection: OpportunitySelection, includeIneligible = false): Promise<SqlRow[]> {
    await this.requireCurrentBatch(workspaceId, radarId, selection.batchId);
    if (selection.mode === 'selected') {
      const ids = [...new Set(selection.ids)];
      if (!ids.length || ids.length > OPPORTUNITY_POLICY.maxSelectedRows) throw machineError('invalid_selection');
      const rows = await this.db.execute(sql`
        SELECT opportunity.*, customer.status AS customer_status, customer.deleted_at AS customer_deleted_at
        FROM opportunity_rows opportunity
        JOIN customers customer ON customer.workspace_id = opportunity.workspace_id AND customer.id = opportunity.customer_id
        WHERE opportunity.workspace_id = ${workspaceId} AND opportunity.batch_id = ${selection.batchId}
          AND opportunity.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
          ${includeIneligible ? sql`` : sql`AND opportunity.eligibility_state = 'eligible' AND customer.status = 'identified' AND customer.deleted_at IS NULL`}
        ORDER BY opportunity.id
      `) as SqlRow[];
      if (rows.length !== ids.length && !includeIneligible) throw machineError('stale_selection');
      return rows;
    }
    const rows: SqlRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(workspaceId, radarId, { ...(selection.query ?? {}), cursor, limit: OPPORTUNITY_POLICY.maxPageSize });
      rows.push(...page.items);
      if (rows.length > OPPORTUNITY_POLICY.maxSelectedRows) throw machineError('selection_too_large');
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return rows;
  }

  private async identifiersFor(workspaceId: string, customerIds: string[]) {
    const result = new Map<string, { type: string; value: string }>();
    if (!customerIds.length) return result;
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (customer_id) customer_id, identifier_type, identifier_value
      FROM customer_identifiers
      WHERE workspace_id = ${workspaceId} AND customer_id IN (${sql.join(customerIds.map((id) => sql`${id}`), sql`,`)})
        AND deleted_at IS NULL AND identifier_type IN ('external_id','email_hash','phone_hash')
      ORDER BY customer_id, CASE identifier_type WHEN 'external_id' THEN 1 WHEN 'email_hash' THEN 2 ELSE 3 END, id
    `) as SqlRow[];
    for (const row of rows) result.set(row.customer_id, { type: row.identifier_type, value: row.identifier_value });
    return result;
  }

  private async destinationState(workspaceId: string, connectionId: string) {
    let connection;
    try { connection = await this.connectorConnections.get(workspaceId, connectionId); } catch { return { status: 'disconnected' as const, definitionVersion: 0, reason: 'destination_not_found' }; }
    const definition = this.connectorRegistry.getDefinition(connection.provider);
    const enabledCapabilities = new Set(connection.capabilities ?? []);
    const providerCapabilities = new Set(definition?.capabilities ?? []);
    const enabled = enabledCapabilities.has('outbound_audience') || enabledCapabilities.has('activation');
    const supported = providerCapabilities.has('outbound_audience');
    if (connection.role === 'source' || !enabled || !supported) {
      return { status: 'capability_mismatch' as const, definitionVersion: 0, reason: 'outbound_audience_required' };
    }
    if (!['connected', 'healthy', 'degraded'].includes(connection.lifecycleState) || connection.credentialStatus !== 'valid' || !this.connectorRegistry.getDestinationAdapter(connection.provider)) {
      return { status: 'disconnected' as const, definitionVersion: 0, reason: 'destination_unavailable' };
    }
    return { status: 'ready' as const, definitionVersion: 0, provider: connection.provider, connectionId };
  }
}
