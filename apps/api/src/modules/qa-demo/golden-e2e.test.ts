/**
 * ORDER 130 — Acceptance Proof: GOLDEN E2E
 * Proves the canonical deterministic journey through the complete Truvo loop:
 * workspace → seed/input → canonical context → anonymous-known identity merge
 * → Radar → scoring → opportunity → activation/export → result/decision.
 * Also proves domain assertions and replay safety against a real migrated database.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '@truvo/db';
import { closeRedis } from '../identity/identity.infra.js';
import { createQaDemoWorkspaceService } from './qa-demo-workspace.service';
import { getSyntheticDatasetV1 } from './fixtures/synthetic-dataset.v1';

const GOLDEN_WS = '33333333-3333-4333-8333-333333333333';
const OPERATOR_USER = '00000000-0000-4000-8000-000000000033';

test('GOLDEN E2E: complete 9-step canonical journey on deterministic demo workspace with replay safety', async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is strictly required for GOLDEN E2E test. Fallback is prohibited.');
  }

  const db = createDb();
  const service = createQaDemoWorkspaceService(db);
  const dataset = getSyntheticDatasetV1();

  try {
    // Step 1: Create & Seed Demo Workspace (Steps 1 to 9 executed canonically)
    const seedResult = await service.createOrResetDemoWorkspace({
      workspaceId: GOLDEN_WS,
      workspaceSlug: 'golden-demo-workspace',
      workspaceName: 'Truvo Golden Demo Workspace',
      operatorUserId: OPERATOR_USER,
    });

    // Domain Assertion: Workspace and personas created
    assert.equal(seedResult.workspaceId, GOLDEN_WS);
    assert.equal(seedResult.datasetVersion, '1.0.0');
    assert.equal(seedResult.entityCounts.customers, 6);
    assert.equal(seedResult.entityCounts.accounts, 2);
    assert.ok(seedResult.entityCounts.traits >= 15);
    assert.ok(seedResult.entityCounts.orders >= 3);
    assert.ok(seedResult.entityCounts.subscriptions >= 2);
    assert.equal(seedResult.entityCounts.identityMerges, 1);

    // Step 3: Canonical Context Records Verification
    const [likelyCustomer] = await db.execute(sql`
      select id, status from customers where workspace_id = ${GOLDEN_WS} and id = ${seedResult.personas.likely_buyer.customerId}
    `) as Array<{ id: string; status: string }>;
    assert.equal(likelyCustomer?.status, 'identified');

    // Step 3b: Canonical B2B Accounts Verification (crm_accounts)
    const accounts = await db.execute(sql`
      select id, name, provider_namespace, traits
      from crm_accounts
      where workspace_id = ${GOLDEN_WS}
      order by id asc
    `) as Array<{ id: string; name: string; provider_namespace: string; traits: { domain?: string; tier?: string } }>;
    assert.equal(accounts.length, 2, 'Declared demo accounts must be persisted in crm_accounts');
    assert.equal(accounts[0].name, 'Acme Retail Group');
    assert.equal(accounts[1].name, 'InovaTech Labs');
    assert.equal(accounts[0].provider_namespace, 'hubspot');

    // Step 4: Anonymous -> Known Identity Merge Verification (Canonical Table: identity_merge_events)
    const [mergeEvent] = await db.execute(sql`
      select id, source_customer_id, target_customer_id, operation
      from identity_merge_events
      where workspace_id = ${GOLDEN_WS} and target_customer_id = ${seedResult.personas.likely_buyer.customerId}
    `) as Array<{ id: string; source_customer_id: string; target_customer_id: string; operation: string }>;
    assert.ok(mergeEvent, 'Identity merge record must exist in identity_merge_events');
    assert.equal(mergeEvent.operation, 'merge');
    assert.equal(mergeEvent.target_customer_id, seedResult.personas.likely_buyer.customerId);

    // Step 5: Radar Creation Verification
    const [radar] = await db.execute(sql`
      select id, name, status, current_definition_version
      from radars
      where workspace_id = ${GOLDEN_WS} and id = ${seedResult.radar.id}
    `) as Array<{ id: string; name: string; status: string; current_definition_version: number }>;
    assert.equal(radar?.status, 'active');
    assert.equal(radar?.current_definition_version, 1);

    // Step 6: Scoring & Propensity Scores Verification
    const scores = await db.execute(sql`
      select customer_id, probability
      from radar_propensity_scores
      where workspace_id = ${GOLDEN_WS} and radar_id = ${seedResult.radar.id}
      order by probability desc
    `) as Array<{ customer_id: string; probability: string }>;
    assert.ok(scores.length >= 4, 'Must have propensity scores for personas');
    const topScore = Number(scores[0]!.probability);
    assert.ok(topScore >= 0.85, 'Top score must be high propensity likely buyer');

    // Step 7: Revenue Opportunities Materialization Verification (Canonical Tables: opportunity_batches & opportunity_rows)
    const [oppBatch] = await db.execute(sql`
      select id, row_count, eligible_count, status
      from opportunity_batches
      where workspace_id = ${GOLDEN_WS} and radar_id = ${seedResult.radar.id} and id = ${seedResult.opportunityBatchId}
    `) as Array<{ id: string; row_count: number; eligible_count: number; status: string }>;
    assert.ok(oppBatch, 'Opportunity batch must exist in opportunity_batches');
    assert.equal(oppBatch.status, 'completed');
    assert.ok(oppBatch.row_count > 0, 'Opportunity batch row_count must be > 0');

    const oppRows = await db.execute(sql`
      select id, batch_id, customer_id, probability, score_band, eligibility_state
      from opportunity_rows
      where workspace_id = ${GOLDEN_WS} and radar_id = ${seedResult.radar.id} and batch_id = ${seedResult.opportunityBatchId}
    `) as Array<{ id: string; batch_id: string; customer_id: string; probability: number; score_band: string; eligibility_state: string }>;
    assert.ok(oppRows.length > 0, 'Materialized opportunity rows must exist in opportunity_rows');
    assert.ok(
      oppRows.some((r) => r.customer_id === seedResult.personas.likely_buyer.customerId),
      'Likely buyer must be present in materialized opportunity rows',
    );

    // Step 8: Outbound Activation Verification (Via Fake Destination Provider)
    assert.ok(seedResult.decisionBatchId, 'Decision batch must be generated upon activation');
    const [actionExec] = await db.execute(sql`
      select e.id, e.remote_id, e.status, e.provider_operation_key
      from action_executions e
      join decision_records d on d.workspace_id = e.workspace_id and d.id = e.decision_id
      where d.workspace_id = ${GOLDEN_WS} and d.decision_batch_id = ${seedResult.decisionBatchId}
    `) as Array<{ id: string; remote_id: string; status: string; provider_operation_key: string }>;
    assert.ok(actionExec?.id, 'Action execution must be recorded in ledger');
    assert.equal(actionExec.status, 'succeeded', 'Action execution status must be succeeded');
    assert.ok(actionExec.remote_id.startsWith('fake_result_'), 'Remote ID must be generated deterministically by fake destination adapter');

    // Step 9: Result & Decision Reconciled
    const [exposure] = await db.execute(sql`
      select id, kind, source_confidence from exposure_observations where workspace_id = ${GOLDEN_WS}
    `) as Array<{ id: string; kind: string; source_confidence: string }>;
    assert.ok(exposure?.id, 'Exposure observation must be present');
    assert.equal(exposure.kind, 'delivered');
    assert.equal(exposure.source_confidence, 'high');

    const [reward] = await db.execute(sql`
      select outcome_count, observed_value, final
      from reward_observations
      where workspace_id = ${GOLDEN_WS}
      order by version desc limit 1
    `) as Array<{ outcome_count: number; observed_value: string; final: boolean }>;
    assert.equal(reward?.final, true, 'Reward observation must be reconciled as final');
    assert.equal(reward?.outcome_count, 1);
    assert.equal(reward?.observed_value, '599.90');

    // Step 10: Replay Safety (Re-running does not duplicate Radar or break idempotency)
    const secondRun = await service.createOrResetDemoWorkspace({
      workspaceId: GOLDEN_WS,
      workspaceSlug: 'golden-demo-workspace',
      workspaceName: 'Truvo Golden Demo Workspace',
      operatorUserId: OPERATOR_USER,
      cleanBeforeSeed: false, // Replay mode
    });

    const [radarsCount] = await db.execute(sql`
      select count(*)::int as count from radars where workspace_id = ${GOLDEN_WS}
    `) as Array<{ count: number }>;
    assert.equal(Number(radarsCount?.count), 1, 'Replay must not duplicate radars (count must remain 1)');
    assert.equal(secondRun.radar.id, seedResult.radar.id, 'Radar ID must be deterministic across replays');
    assert.equal(secondRun.radar.status, 'active', 'Returned radar status must remain active across replays');

    const [radarRow] = await db.execute(sql`
      select status, current_model_reference from radars where workspace_id = ${GOLDEN_WS} and id = ${secondRun.radar.id}
    `) as Array<{ status: string; current_model_reference: string | null }>;
    assert.equal(radarRow?.status, 'active', 'Persisted radar status in DB must remain active across replays');
    assert.equal(radarRow?.current_model_reference, seedResult.radar.modelVersionId, 'Persisted radar current_model_reference must point to active model');

    // Step 11: Monitoring snapshot cleanup proof (verifies ON DELETE RESTRICT fk is handled)
    const snapshotId = `snap_test_${Date.now()}`;
    await db.execute(sql`
      insert into radar_model_monitoring_snapshots (
        workspace_id, id, radar_id, model_version_id, snapshot_type, health_status, metrics, anomalies
      ) values (
        ${GOLDEN_WS}, ${snapshotId}, ${seedResult.radar.id}, ${seedResult.radar.modelVersionId},
        'drift_check', 'healthy', '{}'::jsonb, '[]'::jsonb
      )
    `);

    // Cleanup
    await service.cleanWorkspaceData(GOLDEN_WS);

    const [residualAccounts] = await db.execute(sql`
      select count(*)::int as count from crm_accounts where workspace_id = ${GOLDEN_WS}
    `) as Array<{ count: number }>;
    assert.equal(residualAccounts?.count, 0, 'Residual crm_accounts must be zero after cleanWorkspaceData');

    const [residualSnapshots] = await db.execute(sql`
      select count(*)::int as count from radar_model_monitoring_snapshots where workspace_id = ${GOLDEN_WS}
    `) as Array<{ count: number }>;
    assert.equal(residualSnapshots?.count, 0, 'Residual radar_model_monitoring_snapshots must be zero after cleanWorkspaceData');
  } finally {
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
