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
   * Safety guard: verifies that a workspace is an authorized demo/qa workspace
   * before performing destructive reset or demo mutations.
   */
  private assertDemoWorkspaceSafety(workspaceId: string, slug?: string): void {
    const isSafeId =
      workspaceId.startsWith('00000000-0000-4000-8000-') ||
      workspaceId.startsWith('11111111-') ||
      workspaceId.startsWith('22222222-') ||
      workspaceId.startsWith('33333333-') ||
      workspaceId.startsWith('44444444-') ||
      workspaceId.includes('demo') ||
      workspaceId.includes('qa') ||
      workspaceId.includes('test');

    const isSafeSlug =
      !slug ||
      slug.startsWith('demo-') ||
      slug.startsWith('qa-') ||
      slug.startsWith('test-') ||
      slug.includes('demo') ||
      slug.includes('golden');

    if (!isSafeId && !isSafeSlug) {
      throw new BadRequestException(
        `Safety violation: workspace "${workspaceId}" is not identified as a demo/qa workspace. Refusing to operate.`,
      );
    }
  }

  /**
   * Creates or resets the deterministic demo workspace.
   */
  async createOrResetDemoWorkspace(options: DemoWorkspaceOptions = {}): Promise<DemoWorkspaceSeedResult> {
    const workspaceId = options.workspaceId ?? DEMO_WORKSPACE_DEFAULT_ID;
    const slug = options.workspaceSlug ?? `demo-workspace-${workspaceId.slice(-4)}`;
    const name = options.workspaceName ?? 'Truvo Demo Workspace';
    const operatorId = options.operatorUserId ?? DEMO_OPERATOR_USER_ID;

    this.assertDemoWorkspaceSafety(workspaceId, slug);

    if (options.cleanBeforeSeed !== false) {
      await this.cleanWorkspaceData(workspaceId);
    }

    const dataset = getSyntheticDatasetV1();
    const fixedClock = new Date(dataset.fixedClock);

    // 1. Workspace & Operator User
    await this.db.execute(sql`
      insert into users (id, email)
      values (${operatorId}, 'demo-operator@example.invalid')
      on conflict (id) do update set email = excluded.email
    `);

    await this.db.execute(sql`
      insert into workspaces (id, name, slug, created_by)
      values (${workspaceId}, ${name}, ${slug}, ${operatorId})
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
        (${workspaceId}, ${connectionDestId}, 'klaviyo', 'destination', 'Klaviyo Demo Sync', 'healthy', 'valid', '["outbound_audience","sync"]'::jsonb)
      on conflict (workspace_id, id) do nothing
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
          workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, observed_at
        )
        values (
          ${workspaceId}, ${`id_ext_${cust.id}`}, ${cust.id}, 'qa_demo', 'external_id', ${cust.externalId}, 'qa-demo', ${fixedClock}
        )
        on conflict (workspace_id, id) do nothing
      `);
      identifiersCount += 1;

      // Customer Identifiers: Email Hash
      const emailHash = hashContact(cust.email);
      await this.db.execute(sql`
        insert into customer_identifiers (
          workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, observed_at
        )
        values (
          ${workspaceId}, ${`id_email_${cust.id}`}, ${cust.id}, ${LEGACY_IDENTITY_NAMESPACE}, 'email_hash', ${emailHash}, 'qa-demo', ${fixedClock}
        )
        on conflict (workspace_id, id) do nothing
      `);
      identifiersCount += 1;

      // Customer Identifiers: Phone Hash if present
      if (cust.phone) {
        const phoneHash = hashContact(cust.phone);
        await this.db.execute(sql`
          insert into customer_identifiers (
            workspace_id, id, customer_id, provider_namespace, identifier_type, identifier_value, source_namespace, observed_at
          )
          values (
            ${workspaceId}, ${`id_phone_${cust.id}`}, ${cust.id}, ${LEGACY_IDENTITY_NAMESPACE}, 'phone_hash', ${phoneHash}, 'qa-demo', ${fixedClock}
          )
          on conflict (workspace_id, id) do nothing
        `);
        identifiersCount += 1;
      }

      // Customer Traits
      for (const trait of persona.traits) {
        const traitValue = typeof trait.value === 'object' ? JSON.stringify(trait.value) : String(trait.value);
        await this.db.execute(sql`
          insert into customer_traits (
            workspace_id, customer_id, trait_namespace, trait_key, value_type,
            string_value, number_value, boolean_value, json_value, source_namespace, observed_at
          )
          values (
            ${workspaceId}, ${cust.id}, ${trait.namespace}, ${trait.key}, ${trait.valueType},
            ${trait.valueType === 'string' ? traitValue : null},
            ${trait.valueType === 'number' ? Number(trait.value) : null},
            ${trait.valueType === 'boolean' ? Boolean(trait.value) : null},
            ${trait.valueType === 'json' ? traitValue : null}::jsonb,
            'qa-demo', ${fixedClock}
          )
          on conflict (workspace_id, customer_id, trait_namespace, trait_key)
          do update set
            string_value = excluded.string_value,
            number_value = excluded.number_value,
            boolean_value = excluded.boolean_value,
            json_value = excluded.json_value,
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
              ${order.totalAmount}, ${new Date(order.processedAt)}, 'qa-demo'
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
              ${sub.providerSubscriptionId}, ${sub.status}, ${new Date(sub.currentPeriodEnd)}, ${fixedClock}
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
              workspace_id, connection_id, customer_id, provider_namespace,
              provider_event_id, metric_name, engagement_kind, properties, occurred_at
            )
            values (
              ${workspaceId}, ${connectionDestId}, ${cust.id}, 'klaviyo',
              ${evt.providerEventId}, ${evt.metricName}, ${evt.engagementKind},
              ${JSON.stringify(evt.properties ?? {})}::jsonb, ${new Date(evt.occurredAt)}
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
            ${new Date(trans.transitionedAt)}, ${new Date(trans.transitionedAt)}
          )
          on conflict (workspace_id, id) do nothing
        `);

        // 2. Attach anonymous cookie identifier
        await this.db.execute(sql`
          insert into customer_identifiers (
            workspace_id, id, customer_id, provider_namespace, identifier_type,
            identifier_value, source_namespace, observed_at
          )
          values (
            ${workspaceId}, ${`id_anon_${trans.anonymousCustomerId}`}, ${trans.anonymousCustomerId},
            'truvo_pixel', 'cookie_id', ${trans.anonymousIdentifierValue}, 'qa-demo',
            ${new Date(trans.transitionedAt)}
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
      on conflict (workspace_id, id) do update set status = 'ready_to_train'
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

    // Promote model to active
    await this.models.promote(workspaceId, radarId, modelId, operatorId, 'demo-workspace-activation');

    // 7. Score Batch & Persona Propensities
    const scoreBatchId = `batch_score_${workspaceId.slice(-6)}`;
    const scoreCutoff = fixedClock;

    await this.db.execute(sql`
      insert into radar_score_batches (
        workspace_id, id, radar_id, definition_version, model_version_id,
        scoring_cutoff, status, scored_customer_count, completed_at
      )
      values (
        ${workspaceId}, ${scoreBatchId}, ${radarId}, 1, ${modelId},
        ${scoreCutoff}, 'completed', 5, ${fixedClock}
      )
      on conflict (workspace_id, id) do nothing
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
          on conflict (workspace_id, radar_id, definition_version, model_version_id, customer_id, scoring_cutoff)
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
      const [decisionRow] = await this.db.execute(sql`
        select d.id as decision_id, e.id as execution_id, e.remote_id
        from decision_records d
        join action_executions e on e.workspace_id = d.workspace_id and e.decision_id = d.id
        where d.workspace_id = ${workspaceId} and d.decision_batch_id = ${decisionBatchId}
        limit 1
      `) as Array<{ decision_id: string; execution_id: string; remote_id: string }>;

      if (decisionRow) {
        const likelyBuyerId = personaCustomerMap.likely_buyer.customerId;
        // Record exposure
        await this.db.execute(sql`
          insert into exposure_observations (
            workspace_id, id, decision_id, customer_id, provider_event_id, occurred_at
          )
          values (
            ${workspaceId}, ${`exp_${decisionRow.decision_id}`}, ${decisionRow.decision_id},
            ${likelyBuyerId}, ${`delivery_evt_${decisionRow.decision_id}`}, ${fixedClock}
          )
          on conflict do nothing
        `);

        // Record customer outcome (purchase confirmed)
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
            'qa-demo', '{"provenance":"qa_demo_conversion"}'::jsonb, ${fixedClock}
          )
          on conflict (workspace_id, outcome_namespace, outcome_key, dedupe_key) do nothing
        `);

        // Reconcile decision reward
        await this.db.execute(sql`
          update decision_records
          set reward_window_end = greatest(created_at + interval '1 microsecond', now() - interval '1 millisecond')
          where workspace_id = ${workspaceId} and id = ${decisionRow.decision_id}
        `);
        await this.decisions.reconcileDecision(workspaceId, decisionRow.decision_id);
      }
    }

    return {
      workspaceId,
      workspaceSlug: slug,
      seededAt: fixedClock.toISOString(),
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
        status: 'ready_to_train',
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
  async cleanWorkspaceData(workspaceId: string): Promise<void> {
    this.assertDemoWorkspaceSafety(workspaceId);

    // Delete in reverse dependency order
    await this.db.execute(sql`delete from reward_observations where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from exposure_observations where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from action_executions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from decision_records where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from revenue_opportunities where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from opportunity_batches where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_propensity_scores where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_score_batches where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_model_versions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_training_requests where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radar_definition_versions where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from radars where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from customer_outcomes where workspace_id = ${workspaceId}`);
    await this.db.execute(sql`delete from outcome_definitions where workspace_id = ${workspaceId}`);
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
