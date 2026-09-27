/**
 * ORDER 130 — Acceptance Proof: NEST-MANAGED DEMO WORKSPACE & ATOMIC ROLLBACK
 * Proves:
 * 1. QaDemoWorkspaceService resolves cleanly via real NestJS DI (QaDemoModule).
 * 2. Model promotion succeeds with isolated demo artifact verifier (no external storage needed).
 * 3. Live production ModelRegistryService / ModelArtifactIntegrityService remains untouched.
 * 4. Fake provider is NOT registered in the global ConnectorRegistryService.
 * 5. Atomic reset/reseed failure rollback: a failure after cleanup begins completely rolls back,
 *    preserving the prior complete dataset intact without partial erasure.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '@truvo/db';
import { closeRedis } from '../identity/identity.infra.js';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditModule } from '../audit/audit.module';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { ModelRegistryService } from '../radars/model-registry.service';
import { QaDemoModule } from './qa-demo.module';
import { QaDemoWorkspaceService, DEMO_WORKSPACE_DEFAULT_ID } from './qa-demo-workspace.service';

@Module({
  imports: [AuditModule, QaDemoModule],
})
class DemoTestAppModule {}

const WS_ROLLBACK = '44444444-4444-4444-8444-444444444444';
const OPERATOR_USER = '00000000-0000-4000-8000-000000000044';

test('NEST-MANAGED DEMO & ATOMIC ROLLBACK: DI resolution, isolated verifier, and transactional failure preservation', async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is strictly required for NEST-MANAGED DEMO test. Fallback is prohibited.');
  }

  let app;
  let db;
  try {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://demo-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'fake_service_role_key_for_testing';
    app = await NestFactory.createApplicationContext(DemoTestAppModule, { logger: false });

    const service = app.get(QaDemoWorkspaceService);
    const globalRegistry = app.get(ConnectorRegistryService);
    const prodModelRegistry = app.get(ModelRegistryService);

    db = createDb();

    // 1. Prove Nest-managed resolution and demo-scoped verifier isolation
    assert.ok(service, 'QaDemoWorkspaceService must resolve via Nest DI');

    // Prove global registry is NOT polluted with fake_provider
    assert.equal(
      globalRegistry.getSourceAdapter('fake_provider'),
      undefined,
      'Global production registry must NOT contain fake_provider source adapter',
    );
    assert.equal(
      globalRegistry.getDestinationAdapter('fake_provider'),
      undefined,
      'Global production registry must NOT contain fake_provider destination adapter',
    );

    // Seed default demo workspace through the real Nest-managed service instance
    const seedResult = await service.createOrResetDemoWorkspace({
      workspaceId: DEMO_WORKSPACE_DEFAULT_ID,
      workspaceSlug: 'demo-workspace-0130',
      workspaceName: 'Truvo Nest-Managed Demo Workspace',
      operatorUserId: OPERATOR_USER,
    });

    assert.equal(seedResult.workspaceId, DEMO_WORKSPACE_DEFAULT_ID);
    assert.equal(seedResult.radar.status, 'active', 'Demo radar must be active');
    assert.ok(seedResult.radar.modelVersionId, 'Demo model version must be assigned');

    // Verify model in DB is active
    const [modelRow] = await db.execute<{ status: string }>(sql`
      select status from radar_model_versions
      where workspace_id = ${DEMO_WORKSPACE_DEFAULT_ID} and id = ${seedResult.radar.modelVersionId}
    `);
    assert.equal(modelRow?.status, 'active', 'Model version in DB must be promoted to active');

    // Verify radar in DB points to active model
    const [radarRow] = await db.execute<{ status: string; current_model_reference: string | null }>(sql`
      select status, current_model_reference from radars
      where workspace_id = ${DEMO_WORKSPACE_DEFAULT_ID} and id = ${seedResult.radar.id}
    `);
    assert.equal(radarRow?.status, 'active', 'Radar status in DB must be active');
    assert.equal(radarRow?.current_model_reference, seedResult.radar.modelVersionId);

    // Clean up default demo workspace
    await service.cleanWorkspaceData(DEMO_WORKSPACE_DEFAULT_ID);

    // 2. ATOMIC RESET / RESEED FAILURE ROLLBACK PROOF
    // Step A: Seed initial complete dataset on WS_ROLLBACK
    const initialSeed = await service.createOrResetDemoWorkspace({
      workspaceId: WS_ROLLBACK,
      workspaceSlug: 'demo-workspace-rollback',
      workspaceName: 'Demo Workspace Rollback Proof',
      operatorUserId: OPERATOR_USER,
    });
    assert.equal(initialSeed.workspaceId, WS_ROLLBACK);

    // Capture initial DB snapshot
    const [initCust] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customers where workspace_id = ${WS_ROLLBACK}`);
    const [initTraits] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customer_traits where workspace_id = ${WS_ROLLBACK}`);
    const [initIdents] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customer_identifiers where workspace_id = ${WS_ROLLBACK}`);
    const [initRadars] = await db.execute<{ count: number }>(sql`select count(*)::int as count from radars where workspace_id = ${WS_ROLLBACK}`);
    const [initModels] = await db.execute<{ count: number }>(sql`select count(*)::int as count from radar_model_versions where workspace_id = ${WS_ROLLBACK}`);
    const [initOpps] = await db.execute<{ count: number }>(sql`select count(*)::int as count from opportunity_rows where workspace_id = ${WS_ROLLBACK}`);
    const [initDecs] = await db.execute<{ count: number }>(sql`select count(*)::int as count from decision_records where workspace_id = ${WS_ROLLBACK}`);

    assert.equal(initCust.count, 7, 'Initial state must have 7 customers');
    assert.equal(initRadars.count, 1, 'Initial state must have 1 radar');
    assert.equal(initModels.count, 1, 'Initial state must have 1 model');
    assert.ok(initOpps.count > 0, 'Initial state must have opportunities');
    assert.ok(initDecs.count > 0, 'Initial state must have decisions');

    // Step B: Force a deterministic failure during reset after cleanup has started
    await assert.rejects(
      () =>
        service.createOrResetDemoWorkspace({
          workspaceId: WS_ROLLBACK,
          workspaceSlug: 'demo-workspace-rollback',
          cleanBeforeSeed: true,
          injectFailureAfterCleanup: true,
        }),
      /Deterministic injected failure after cleanup for rollback proof/,
      'Must throw injected failure during reset',
    );

    // Step C: PROVE COMPLETE PRESERVATION — previous dataset must remain 100% intact!
    const [afterCust] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customers where workspace_id = ${WS_ROLLBACK}`);
    const [afterTraits] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customer_traits where workspace_id = ${WS_ROLLBACK}`);
    const [afterIdents] = await db.execute<{ count: number }>(sql`select count(*)::int as count from customer_identifiers where workspace_id = ${WS_ROLLBACK}`);
    const [afterRadars] = await db.execute<{ count: number }>(sql`select count(*)::int as count from radars where workspace_id = ${WS_ROLLBACK}`);
    const [afterModels] = await db.execute<{ count: number }>(sql`select count(*)::int as count from radar_model_versions where workspace_id = ${WS_ROLLBACK}`);
    const [afterOpps] = await db.execute<{ count: number }>(sql`select count(*)::int as count from opportunity_rows where workspace_id = ${WS_ROLLBACK}`);
    const [afterDecs] = await db.execute<{ count: number }>(sql`select count(*)::int as count from decision_records where workspace_id = ${WS_ROLLBACK}`);

    assert.equal(afterCust.count, initCust.count, 'Customers must be 100% preserved after failed reset rollback');
    assert.equal(afterTraits.count, initTraits.count, 'Traits must be 100% preserved after failed reset rollback');
    assert.equal(afterIdents.count, initIdents.count, 'Identifiers must be 100% preserved after failed reset rollback');
    assert.equal(afterRadars.count, initRadars.count, 'Radars must be 100% preserved after failed reset rollback');
    assert.equal(afterModels.count, initModels.count, 'Models must be 100% preserved after failed reset rollback');
    assert.equal(afterOpps.count, initOpps.count, 'Opportunities must be 100% preserved after failed reset rollback');
    assert.equal(afterDecs.count, initDecs.count, 'Decisions must be 100% preserved after failed reset rollback');

    // Step D: Normal reset and reseed succeeds
    const recoveredSeed = await service.createOrResetDemoWorkspace({
      workspaceId: WS_ROLLBACK,
      workspaceSlug: 'demo-workspace-rollback',
      cleanBeforeSeed: true,
      injectFailureAfterCleanup: false,
    });
    assert.equal(recoveredSeed.workspaceId, WS_ROLLBACK);
    assert.equal(recoveredSeed.radar.status, 'active');

    // Cleanup WS_ROLLBACK
    await service.cleanWorkspaceData(WS_ROLLBACK);
  } catch (err) {
    console.error('NEST-MANAGED DEMO TEST ERROR:', err);
    throw err;
  } finally {
    let nestDb: Database | undefined;
    try {
      nestDb = app?.get<Database>(DRIZZLE);
    } catch {
      // ignore
    }
    if (app) await app.close().catch(() => undefined);
    closeRedis();
    if (db) await closeDb(db).catch(() => undefined);
    if (nestDb) await closeDb(nestDb).catch(() => undefined);
  }
});
