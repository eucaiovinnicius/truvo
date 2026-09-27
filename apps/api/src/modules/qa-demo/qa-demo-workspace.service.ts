/**
 * ORDER 130 — SPEC-21: QA & Workspace de Demonstração v1
 * Deterministic Demo Workspace management service.
 * Handles safe creation, synthetic seeding, reset, and teardown.
 */

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { CustomerContextService, LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { RadarService } from '../radars/radar.service';
import { ModelRegistryService } from '../radars/model-registry.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { DecisionsService } from '../decisions/decisions.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { ConnectorDestinationService } from '../connectors/connector-destination.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { EngagementWriteService } from '../connectors/engagement/engagement-write.service';
import {
  createFakeDestinationAdapter,
  createFakeProviderState,
  createFakeSourceAdapter,
  FAKE_PROVIDER,
} from '../connectors/testing/fake-provider.adapter';
import {
  type DemoWorkspaceOptions,
  type DemoWorkspaceSeedResult,
  type PersonaType,
} from './qa-demo.contracts';
import { getSyntheticDatasetV1, hashContact } from './fixtures/synthetic-dataset.v1';

export const DEMO_WORKSPACE_DEFAULT_ID = '00000000-0000-4000-8000-000000000130';
export const DEMO_OPERATOR_USER_ID = '00000000-0000-4000-8000-000000000999';

export function isReservedDemoWorkspaceId(workspaceId?: string): boolean {
  if (!workspaceId) return false;
  const id = workspaceId.toLowerCase();
  if (
    id.startsWith('00000000-0000-4000-8000-') ||
    id.startsWith('11111111-') ||
    id.startsWith('22222222-') ||
    id.startsWith('33333333-') ||
    id.startsWith('44444444-')
  ) {
    return true;
  }
  const tokens = id.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => ['demo', 'qa', 'test', 'golden'].includes(token));
}

export function isExplicitDemoSlug(slug?: string): boolean {
  if (!slug) return false;
  const tokens = slug.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => ['demo', 'qa', 'test', 'golden'].includes(token));
}

@Injectable()
export class QaDemoWorkspaceService {
  private readonly logger = new Logger(QaDemoWorkspaceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly identityGraph: IdentityGraphService,
    private readonly customerContext: CustomerContextService,
    private readonly radars: RadarService,
    private readonly models: ModelRegistryService,
    private readonly opportunities: OpportunitiesService,
    private readonly decisions: DecisionsService,
  ) {}

  /**
   * Safety guard: verifies affirmative demo/QA identification before any destructive reset
   * or creation. Never accepts absent slug or generated slug on an arbitrary/production workspace.
   */
  async assertAffirmativeDemoWorkspace(workspaceId: string, callerSlug?: string): Promise<void> {
    if (!workspaceId) {
      throw new BadRequestException('Safety violation: workspaceId is required.');
    }

    // 1. If workspace already exists in DB, the persisted DB record itself MUST be demo/qa.
    const existingRows = await this.db.execute<{ id: string; slug: string; name: string }>(sql`
      select id, slug, name from workspaces where id = ${workspaceId} limit 1
    `);
    const existing = existingRows[0];

    if (existing) {
      const dbHasDemoId = isReservedDemoWorkspaceId(existing.id);
      const dbHasDemoSlug = isExplicitDemoSlug(existing.slug);
      if (!dbHasDemoId && !dbHasDemoSlug) {
        throw new BadRequestException(
          `Safety violation: existing workspace "${workspaceId}" (slug: "${existing.slug}") is not an affirmative demo/qa workspace in database. Refusing destructive operations.`,
        );
      }
      return;
    }

    // 2. If workspace does not exist yet:
    // It must be a reserved demo ID AND (callerSlug is demo slug OR callerSlug is absent for reserved demo ID)
    const hasReservedId = isReservedDemoWorkspaceId(workspaceId);
    const hasExplicitSlug = isExplicitDemoSlug(callerSlug);

    if (!hasReservedId || (callerSlug !== undefined && !hasExplicitSlug)) {
      throw new BadRequestException(
        `Safety violation: workspace "${workspaceId}" (slug: "${callerSlug ?? 'none'}") is not an authorized new demo workspace. Both ID and slug must affirmatively match demo/qa conventions.`,
      );
    }
  }

  /**
   * Creates or resets the deterministic demo workspace.
   */
  async createOrResetDemoWorkspace(options: DemoWorkspaceOptions = {}): Promise<DemoWorkspaceSeedResult> {
    const workspaceId = options.workspaceId ?? DEMO_WORKSPACE_DEFAULT_ID;
    const [existingWs] = await this.db.execute(sql`
      select id, slug from workspaces where id = ${workspaceId}
    `) as Array<{ id: string; slug: string }>;
    const effectiveSlug = options.workspaceSlug ?? existingWs?.slug ?? `demo-workspace-${workspaceId.slice(-4)}`;
    const name = options.workspaceName ?? 'Truvo Demo Workspace';
    const operatorId = options.operatorUserId ?? DEMO_OPERATOR_USER_ID;

    await this.assertAffirmativeDemoWorkspace(workspaceId, options.workspaceSlug ?? existingWs?.slug);

    if (options.cleanBeforeSeed !== false) {
      await this.cleanWorkspaceData(workspaceId, effectiveSlug);
    }

    const dataset = getSyntheticDatasetV1();
    const fixedClock = dataset.fixedClock;

    // 1. Workspace & Operator User
    const operatorEmail = `demo-operator-${operatorId}@example.invalid`;
    await this.db.execute(sql`
      insert into users (id, email)
      values (${operatorId}, ${operatorEmail})
      on conflict (id) do update set email = excluded.email
    `);

    await this.db.execute(sql`
      insert into workspaces (id, name, slug, created_by)
      values (${workspaceId}, ${name}, ${effectiveSlug}, ${operatorId})
      on conflict (id) do update set name = excluded.name, slug = excluded.slug
    `);

    await this.db.execute(sql`
      insert into workspace_members (workspace_id, user_id, role, status)
      values (${workspaceId}, ${operatorId}, 'owner', 'active')
      on conflict (workspace_id, user_id) do update set role = 'owner', status = 'active'
    `);

    // 2. Target Outcome Definitions
    for (const outcome of dataset.targetOutcomes) {
      await this.db.execute(sql`
        insert into outcome_definitions (
          workspace_id, id, outcome_namespace, outcome_key, name, kind, definition, source_namespace
        )
        values (
          ${workspaceId}, ${outcome.id}, ${outcome.outcomeNamespace}, ${outcome.outcomeKey},
          ${outcome.name}, ${outcome.kind}, ${JSON.stringify({ event_name: outcome.outcomeKey })}::jsonb, 'qa-demo'
        )
        on conflict (workspace_id, id) do nothing
      `);
    }

    // 3. Connectors: Source and Destination
    const connectionSourceId = `conn_source_${workspaceId.slice(-6)}`;
    const connectionDestId = `conn_dest_${workspaceId.slice(-6)}`;

    await this.db.execute(sql`
      insert into connector_connections (
        workspace_id, id, provider, role, display_name, lifecycle_state, credential_status, capabilities
      )
      values
        (${workspaceId}, ${connectionSourceId}, 'shopify', 'source', 'Shopify Demo Store', 'healthy', 'valid', '["read","initial_backfill"]'::jsonb),
        (${workspaceId}, ${connectionDestId}, ${FAKE_PROVIDER}, 'destination', 'Demo Destination Sync', 'healthy', 'valid', '["outbound_audience","sync"]'::jsonb)
      on conflict (workspace_id, id) do update set provider = excluded.provider, capabilities = excluded.capabilities
    `);

    // 4. Seed Personas & Entities
    const personaCustomerMap: Record<PersonaType, { customerId: string; externalId: string }> = {} as never;
    let customersCount = 0;
    let traitsCount = 0;
    let identifiersCount = 0;
    let ordersCount = 0;
    let subscriptionsCount = 0;
    let engagementCount = 0;
    let mergesCount = 0;

    for (const [pKey, persona] of Object.entries(dataset.personas) as Array<[PersonaType, (typeof dataset.personas)[PersonaType]]>) {
      const cust = persona.customer;
      personaCustomerMap[pKey] = { customerId: cust.id, externalId: cust.externalId };

      // Insert Customer
      await this.db.execute(sql`
        insert into customers (
          workspace_id, id, status, source_namespace, first_seen_at, last_seen_at
        )
        values (
          ${workspaceId}, ${cust.id}, ${cust.status}, 'qa-demo', ${fixedClock}, ${fixedClock}
        )
        on conflict (workspace_id, id) do nothing
      `);
      customersCount += 1;

      // Customer Identifiers: External ID
      await this.db.execute(sql`
        insert into customer_identifiers (
          workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, first_seen_at, last_seen_at
        )
        values (
          ${workspaceId}, ${`id_ext_${cust.id}`}, ${cust.id}, 'qa_demo', 'external_id', ${cust.externalId}, 'qa-demo', ${fixedClock}, ${fixedClock}
        )
        on conflict (workspace_id, id) do nothing
      `);
      identifiersCount += 1;

      // Customer Identifiers: Email Hash
      const emailHash = hashContact(cust.email);
      await this.db.execute(sql`
        insert into customer_identifiers (
          workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, first_seen_at, last_seen_at
        )
        values (
          ${workspaceId}, ${`id_email_${cust.id}`}, ${cust.id}, ${LEGACY_IDENTITY_NAMESPACE}, 'email_hash', ${emailHash}, 'qa-demo', ${fixedClock}, ${fixedClock}
        )
        on conflict (workspace_id, id) do nothing
      `);
      identifiersCount += 1;

      // Customer Identifiers: Phone Hash if present
      if (cust.phone) {
        const phoneHash = hashContact(cust.phone);
        await this.db.execute(sql`
          insert into customer_identifiers (
            workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, first_seen_at, last_seen_at
          )
          values (
            ${workspaceId}, ${`id_phone_${cust.id}`}, ${cust.id}, ${LEGACY_IDENTITY_NAMESPACE}, 'phone_hash', ${phoneHash}, 'qa-demo', ${fixedClock}, ${fixedClock}
          )
          on conflict (workspace_id, id) do nothing
        `);
        identifiersCount += 1;
      }

      // Customer Traits
      for (const trait of persona.traits) {
        await this.db.execute(sql`
          insert into customer_traits (
            workspace_id, id, customer_id, trait_namespace, trait_key, value_type,
            value, source_namespace, observed_at
          )
          values (
            ${workspaceId}, ${`tr_${cust.id}_${trait.key}`}, ${cust.id}, ${trait.namespace}, ${trait.key}, ${trait.valueType},
            ${JSON.stringify(trait.value)}::jsonb, 'qa-demo', ${fixedClock}
          )
          on conflict (workspace_id, customer_id, trait_namespace, trait_key)
          do update set
            value = excluded.value,
            observed_at = excluded.observed_at
        `);
        traitsCount += 1;
      }

      // Orders if present (Persona: repeat_buyer)
      if (persona.orders) {
        for (const order of persona.orders) {
          await this.db.execute(sql`
            insert into commerce_orders (
              workspace_id, id, connection_id, customer_id, provider_namespace,
              provider_order_id, financial_status, currency, total_amount, order_timestamp, source_namespace
            )
            values (
              ${workspaceId}, ${order.id}, ${connectionSourceId}, ${cust.id}, 'shopify',
              ${order.providerOrderId}, ${order.financialStatus}, ${order.currency},
              ${order.totalAmount}, ${order.processedAt}, 'qa-demo'
            )
            on conflict (workspace_id, id) do nothing
          `);
          ordersCount += 1;

          for (const [idx, item] of order.lineItems.entries()) {
            await this.db.execute(sql`
              insert into commerce_order_line_items (
                workspace_id, id, order_id, provider_line_item_id, provider_product_id,
                name, quantity, price, currency
              )
              values (
                ${workspaceId}, ${`${order.id}_item_${idx}`}, ${order.id}, ${`pli_${order.id}_${idx}`},
                ${item.productId}, ${item.title}, ${item.quantity}, ${item.unitPrice}, ${order.currency}
              )
              on conflict (workspace_id, id) do nothing
            `);
          }
        }
      }

      // Subscriptions if present (Persona: subscription_upgrade_candidate & churn_like_history)
      if (persona.subscriptions) {
        for (const sub of persona.subscriptions) {
          await this.db.execute(sql`
            insert into billing_context_subscriptions (
              workspace_id, id, connection_id, customer_id, provider_namespace,
              provider_subscription_id, status, current_period_end, source_updated_at
            )
            values (
              ${workspaceId}, ${sub.id}, ${connectionSourceId}, ${cust.id}, 'stripe',
              ${sub.providerSubscriptionId}, ${sub.status}, ${sub.currentPeriodEnd}, ${fixedClock}
            )
            on conflict (workspace_id, id) do nothing
          `);
          subscriptionsCount += 1;
        }
      }

      // Engagement events if present
      if (persona.engagementEvents) {
        for (const evt of persona.engagementEvents) {
          await this.db.execute(sql`
            insert into engagement_events (
              workspace_id, id, connection_id, customer_id, provider_namespace,
              provider_event_id, metric_name, engagement_kind, occurred_at
            )
            values (
              ${workspaceId}, ${`evt_${workspaceId.slice(-6)}_${evt.providerEventId}`}, ${connectionDestId}, ${cust.id}, 'klaviyo',
              ${evt.providerEventId}, ${evt.metricName}, ${evt.engagementKind},
              ${evt.occurredAt}
            )
            on conflict (workspace_id, provider_namespace, provider_event_id) do nothing
          `);
          engagementCount += 1;
        }
      }

      // Anonymous -> Known Identity Transition (Persona: likely_buyer)
      if (persona.identityTransition) {
        const trans = persona.identityTransition;
        // 1. Create anonymous customer
        await this.db.execute(sql`
          insert into customers (
            workspace_id, id, status, source_namespace, first_seen_at, last_seen_at
          )
          values (
            ${workspaceId}, ${trans.anonymousCustomerId}, 'anonymous', 'qa-demo',
            ${trans.transitionedAt}, ${trans.transitionedAt}
          )
          on conflict (workspace_id, id) do nothing
        `);

        // 2. Attach anonymous cookie identifier
        await this.db.execute(sql`
          insert into customer_identifiers (
            workspace_id, id, customer_id, provider_namespace, identifier_type,
            identifier_value, source_namespace, first_seen_at, last_seen_at
          )
          values (
            ${workspaceId}, ${`id_anon_${trans.anonymousCustomerId}`}, ${trans.anonymousCustomerId},
            'truvo_pixel', 'anonymous_id', ${trans.anonymousIdentifierValue}, 'qa-demo',
            ${trans.transitionedAt}, ${trans.transitionedAt}
          )
          on conflict (workspace_id, id) do nothing
        `);

        // 3. Perform canonical merge via IdentityGraphService
        await this.identityGraph.mergeCustomers({
          workspaceId,
          sourceCustomerId: trans.anonymousCustomerId,
          targetCustomerId: cust.id,
          reason: trans.reason,
          sourceNamespace: 'qa-demo',
          actor: { type: 'system' },
        });
        mergesCount += 1;
      }
    }

    // 5. Radar Creation
    const radarId = `rad_demo_${workspaceId.slice(-6)}`;
    const outcomeDefinitionId = 'outcome_purchase';

    await this.db.execute(sql`
      insert into radars (workspace_id, id, name, status, current_definition_version)
      values (${workspaceId}, ${radarId}, 'Purchase Propensity Radar (30d)', 'ready_to_train', 1)
      on conflict (workspace_id, id) do update set
        status = case when radars.status = 'active' then 'active' else excluded.status end
    `);

    await this.db.execute(sql`
      insert into radar_definition_versions (
        workspace_id, radar_id, version, outcome_definition_id, audience_ast,
        prediction_window_days, optimization_goal, activation_destination, readiness
      )
      values (
        ${workspaceId}, ${radarId}, 1, ${outcomeDefinitionId},
        '{"version":1,"op":"identified"}'::jsonb, 30, '{}'::jsonb,
        ${JSON.stringify({ connectionId: connectionDestId, capability: 'outbound_audience' })}::jsonb,
        '{"status":"ready"}'::jsonb
      )
      on conflict (workspace_id, radar_id, version) do nothing
    `);

    // 6. Validated Model Version & Promotion
    const trainingRequestId = `rtr_demo_${workspaceId.slice(-6)}`;
    const modelId = `mdl_demo_${workspaceId.slice(-6)}`;

    await this.db.execute(sql`
      insert into radar_training_requests (
        workspace_id, id, radar_id, definition_version, idempotency_key, status, correlation_id
      )
      values (
        ${workspaceId}, ${trainingRequestId}, ${radarId}, 1,
        ${`idemp_train_${radarId}`}, 'succeeded', 'corr_demo_train'
      )
      on conflict (workspace_id, id) do nothing
    `);

    await this.db.execute(sql`
      insert into radar_model_versions (
        workspace_id, id, radar_id, definition_version, training_request_id,
        target_outcome_definition_id, prediction_window_days, status, estimator_type,
        feature_schema_version, artifact_provider, artifact_bucket, artifact_object_key,
        artifact_reference, artifact_checksum, cutoff_ranges, data_counts, metrics,
        calibration, selection_reason, verified_at
      )
      values (
        ${workspaceId}, ${modelId}, ${radarId}, 1, ${trainingRequestId},
        ${outcomeDefinitionId}, 30, 'validated', 'logistic_regression',
        'propensity-v1', 'supabase_storage', 'models',
        ${`workspaces/${workspaceId}/radars/${radarId}/model.joblib`},
        ${`supabase://models/workspaces/${workspaceId}/radars/${radarId}/model.joblib`},
        ${'e'.repeat(64)}, '{}'::jsonb, '{"positive":120,"negative":880}'::jsonb,
        '{"auc":0.89,"brier":0.08}'::jsonb, '{}'::jsonb, 'qa-demo-validated-baseline', ${fixedClock}
      )
      on conflict (workspace_id, id) do nothing
    `);

    // Promote model to active only if not already active (idempotent for replay)
    const [existingModel] = await this.db.execute<{ status: string }>(sql`
      select status from radar_model_versions
      where workspace_id = ${workspaceId} and id = ${modelId}
      limit 1
    `);
    const [currentRadar] = await this.db.execute<{ status: string; current_model_reference: string | null }>(sql`
      select status, current_model_reference from radars
      where workspace_id = ${workspaceId} and id = ${radarId}
      limit 1
    `);

    if (existingModel?.status !== 'active') {
      await this.models.promote(workspaceId, radarId, modelId, operatorId, 'demo-workspace-activation');
    } else if (currentRadar?.status !== 'active' || currentRadar?.current_model_reference !== modelId) {
      await this.db.execute(sql`
        update radars
        set status = 'active', current_model_reference = ${modelId}, updated_at = now()
        where workspace_id = ${workspaceId} and id = ${radarId}
      `);
    }

    // 7. Score Batch & Persona Propensities
    const scoreBatchId = `batch_score_${workspaceId.slice(-6)}`;
    const scoreCutoff = fixedClock;

    await this.db.execute(sql`
      insert into radar_score_batches (
        workspace_id, radar_id, definition_version, model_version_id,
        scoring_cutoff, status, scored_customer_count, completed_at
      )
      values (
        ${workspaceId}, ${radarId}, 1, ${modelId},
        ${scoreCutoff}, 'completed', 5, ${fixedClock}
      )
      on conflict (workspace_id, radar_id, model_version_id, scoring_cutoff) do nothing
    `);

    for (const persona of Object.values(dataset.personas)) {
      if (persona.expectedPropensityScore !== null) {
        await this.db.execute(sql`
          insert into radar_propensity_scores (
            workspace_id, radar_id, definition_version, model_version_id, customer_id,
            scoring_cutoff, probability, feature_schema_version, reason_codes, scored_at
          )
          values (
            ${workspaceId}, ${radarId}, 1, ${modelId}, ${persona.customer.id},
            ${scoreCutoff}, ${persona.expectedPropensityScore}, 'propensity-v1',
            ${JSON.stringify([`${persona.type}_signal`])}::jsonb, ${fixedClock}
          )
          on conflict (workspace_id, radar_id, model_version_id, customer_id, scoring_cutoff)
          do update set probability = excluded.probability
        `);
      }
    }

    // 8. Materialize Revenue Opportunities
    const oppBatch = await this.opportunities.materialize(workspaceId, radarId, 'qa-demo-seed');

    // 9. Activation & Outbound Export
    const oppList = await this.opportunities.list(workspaceId, radarId, { sort: 'probability', limit: 10 });
    const selectedOppIds = oppList.items.map((item) => item.id);

    let decisionBatchId = '';
    if (selectedOppIds.length > 0) {
      const actRes = await this.opportunities.activate(workspaceId, operatorId, {
        radarId,
        selection: { mode: 'selected', batchId: oppBatch.id, ids: selectedOppIds },
        correlationId: `corr_demo_activation_${workspaceId.slice(-6)}`,
        connectionId: connectionDestId,
        idempotencyKey: `idemp_demo_act_${workspaceId.slice(-6)}`,
      });
      if (actRes.decisionBatchId) {
        decisionBatchId = actRes.decisionBatchId;
      }
    }
    if (decisionBatchId) {
      const likelyBuyerId = personaCustomerMap.likely_buyer.customerId;
      const [decisionRow] = await this.db.execute(sql`
        select d.id as decision_id, d.customer_id, e.id as execution_id, e.remote_id
        from decision_records d
        join action_executions e on e.workspace_id = d.workspace_id and e.decision_id = d.id
        where d.workspace_id = ${workspaceId}
          and d.decision_batch_id = ${decisionBatchId}
          and d.customer_id = ${likelyBuyerId}
        limit 1
      `) as Array<{ decision_id: string; customer_id: string; execution_id: string; remote_id: string }>;

      if (decisionRow) {
        // Set decision created_at and reward_window_end so outcome fits cleanly inside the closed window
        await this.db.execute(sql`
          update decision_records
          set created_at = now() - interval '10 seconds',
              reward_window_end = now() - interval '1 millisecond'
          where workspace_id = ${workspaceId} and id = ${decisionRow.decision_id}
        `);

        // Record exposure
        await this.db.execute(sql`
          insert into exposure_observations (
            workspace_id, id, decision_id, execution_id, kind, source_confidence, provider_event_id, occurred_at
          )
          values (
            ${workspaceId}, ${`exp_${decisionRow.decision_id}`}, ${decisionRow.decision_id},
            ${decisionRow.execution_id}, 'delivered', 'high', ${`delivery_evt_${decisionRow.decision_id}`}, now() - interval '8 seconds'
          )
          on conflict do nothing
        `);

        // Record customer outcome (purchase confirmed) inside the decision's reward window
        const outcomeEventId = `evt_purchase_${workspaceId.slice(-6)}`;
        await this.db.execute(sql`
          insert into customer_outcomes (
            workspace_id, id, customer_id, outcome_definition_id, outcome_namespace,
            outcome_key, dedupe_key, event_id, value, currency, source_namespace, provenance, observed_at
          )
          values (
            ${workspaceId}, ${`out_${decisionRow.decision_id}`}, ${likelyBuyerId},
            'outcome_purchase', 'canonical', 'purchase',
            ${`order_demo_${workspaceId.slice(-6)}`}, ${outcomeEventId}, 599.90, 'BRL',
            'qa-demo', '{"provenance":"qa_demo_conversion"}'::jsonb, now() - interval '5 seconds'
          )
          on conflict (workspace_id, outcome_namespace, outcome_key, dedupe_key) do nothing
        `);

        // Reconcile decision reward
        await this.decisions.reconcileDecision(workspaceId, decisionRow.decision_id);
      }
    }

    const [finalRadar] = await this.db.execute<{ status: string; current_model_reference: string | null }>(sql`
      select status, current_model_reference from radars where workspace_id = ${workspaceId} and id = ${radarId} limit 1
    `);

    return {
      workspaceId,
      workspaceSlug: effectiveSlug,
      seededAt: fixedClock,
      datasetVersion: dataset.version,
      personas: personaCustomerMap,
      entityCounts: {
        customers: customersCount,
        traits: traitsCount,
        identifiers: identifiersCount,
        orders: ordersCount,
        subscriptions: subscriptionsCount,
        engagementEvents: engagementCount,
        identityMerges: mergesCount,
      },
      radar: {
        id: radarId,
        name: 'Purchase Propensity Radar (30d)',
        status: finalRadar?.status ?? 'active',
        definitionVersion: 1,
        modelVersionId: modelId,
        scoreBatchId,
      },
      opportunityBatchId: oppBatch.id,
      decisionBatchId,
    };
  }

  /**
   * Resets/cleans data for a demo workspace.
   */
  async cleanWorkspaceData(workspaceId: string, slug?: string): Promise<void> {
    await this.assertAffirmativeDemoWorkspace(workspaceId, slug);

    // Delete in reverse foreign-key dependency order
    await this.db.execute(sql`delete from decision_reward_reconciliation_checkpoints where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from reward_observations where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from exposure_observations where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from action_execution_attempts where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from action_executions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from decision_eligible_actions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from decision_records where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from decision_context_snapshots where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from opportunity_activations where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from opportunity_exports where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from opportunity_rows where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from opportunity_batches where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_propensity_scores where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_score_batches where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_model_versions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_training_requests where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_definition_versions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radars where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from customer_outcomes where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from outcome_definitions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from connector_connections where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from engagement_events where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from billing_context_subscriptions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from commerce_order_line_items where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from commerce_orders where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from identity_links where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from identity_merges where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from identity_merge_events where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from customer_traits where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from customer_identifiers where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from customers where workspace_id = ${workspaceId}`);
  }
}

/**
 * Factory helper for testing and CLI scripts outside NestJS DI.
 */
export function createQaDemoWorkspaceService(db: Database): QaDemoWorkspaceService {
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const context = new CustomerContextService(db, suppression);
  const identity = new IdentityGraphService(db, context, suppression);
  const decisions = new DecisionsService(db, audit);
  const registry = new ConnectorRegistryService();
  const state = createFakeProviderState();
  registry.registerSource(createFakeSourceAdapter(state));
  registry.registerDestination(createFakeDestinationAdapter(state));
  const connections = new ConnectorConnectionService(db, audit, registry);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const opportunities = new OpportunitiesService(db, audit, connections, registry, destination, decisions);
  const artifacts = { verify: async () => ({ ok: true }) };
  const models = new ModelRegistryService(db, audit, artifacts as never);
  const quality = { checkReadiness: async () => ({ ready: true }) };
  const radars = new RadarService(db, quality as never);

  return new QaDemoWorkspaceService(
    db,
    identity,
    context,
    radars,
    models,
    opportunities,
    decisions,
  );
}
