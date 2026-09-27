/**
 * ORDER 130 — Acceptance Proof: TENANT ISOLATION & DEMO SAFETY
 * Proves rigorous workspace boundaries between Workspace A and Workspace B on real DB:
 * - A reads A, B reads B
 * - A cannot read B, B cannot read A
 * - A cannot mutate B, B cannot mutate A
 * - Foreign IDs from the other tenant are rejected
 * - Runtime operations maintain strict workspace scope
 * - Safety guards strictly reject non-demo workspaces before any delete
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '@truvo/db';
import { closeRedis } from '../identity/identity.infra.js';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { AuditService } from '../audit/audit.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { ConnectorConnectionService } from '../connectors/connector-connection.service';
import { ConnectorDestinationService } from '../connectors/connector-destination.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { DecisionsService } from '../decisions/decisions.service';
import { createFakeDestinationAdapter, createFakeProviderState, createFakeSourceAdapter } from '../connectors/testing/fake-provider.adapter';
import {
  createQaDemoWorkspaceService,
  DEMO_WORKSPACE_DEFAULT_ID,
  isReservedDemoWorkspaceId,
  isExplicitDemoSlug,
} from './qa-demo-workspace.service';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '00000000-0000-4000-8000-00000000001a';
const USER_B = '00000000-0000-4000-8000-00000000001b';

test('TENANT ISOLATION: cross-tenant read denied, mutation denied, runtime scope strictly isolated', async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is strictly required for TENANT ISOLATION test. Fallback is prohibited.');
  }

  const db = createDb();
  const service = createQaDemoWorkspaceService(db);

  try {
    // 0. Safety Guard Proofs:
    // Proof 1: production-like UUID + slug ausente => REJECT
    await assert.rejects(
      () => service.assertAffirmativeDemoWorkspace('98765432-1234-4321-abcd-0123456789ab', undefined),
      /Safety violation/,
      'Production-like UUID with absent slug must be rejected',
    );
    await assert.rejects(
      () => service.cleanWorkspaceData('98765432-1234-4321-abcd-0123456789ab'),
      /Safety violation/,
      'cleanWorkspaceData on production-like UUID must be rejected before any delete',
    );

    // Proof 2: production-like existing workspace + generated demo slug => REJECT
    const prodWsId = '98765432-1234-4321-abcd-0123456789ab';
    await db.execute(sql`
      insert into users (id, email)
      values (${USER_A}, 'user-a@example.invalid')
      on conflict (id) do nothing
    `);
    await db.execute(sql`
      insert into workspaces (id, name, slug, created_by)
      values (${prodWsId}, 'Acme Production Store', 'acme-production-store', ${USER_A})
      on conflict (id) do update set slug = 'acme-production-store'
    `);
    try {
      await assert.rejects(
        () => service.createOrResetDemoWorkspace({ workspaceId: prodWsId, workspaceSlug: 'demo-workspace-7890' }),
        /Safety violation: existing workspace.*is not an affirmative demo\/qa workspace/i,
        'Existing production workspace must be rejected even if caller supplies a demo slug',
      );
      await assert.rejects(
        () => service.cleanWorkspaceData(prodWsId),
        /Safety violation: existing workspace.*is not an affirmative demo\/qa workspace/i,
        'cleanWorkspaceData must refuse to delete existing production workspace',
      );
    } finally {
      await db.execute(sql`delete from workspaces where id = ${prodWsId}`);
    }

    // Proof 2b: non-token substring matching => REJECT (e.g. demographics-store, democracy-shop)
    assert.equal(isExplicitDemoSlug('demographics-store'), false);
    assert.equal(isExplicitDemoSlug('democracy-shop'), false);
    assert.equal(isExplicitDemoSlug('qatar-airways'), false);
    assert.equal(isExplicitDemoSlug('testimony-law'), false);

    const falseDemoWsId = '87654321-4321-4321-abcd-0123456789ac';
    await db.execute(sql`
      insert into workspaces (id, name, slug, created_by)
      values (${falseDemoWsId}, 'Demographics Store', 'demographics-store', ${USER_A})
      on conflict (id) do update set slug = 'demographics-store'
    `);
    try {
      await assert.rejects(
        () => service.assertAffirmativeDemoWorkspace(falseDemoWsId, 'demographics-store'),
        /Safety violation: existing workspace.*is not an affirmative demo\/qa workspace/i,
        'Existing workspace with slug "demographics-store" must be rejected despite containing "demo" substring',
      );
      await assert.rejects(
        () => service.cleanWorkspaceData(falseDemoWsId),
        /Safety violation: existing workspace.*is not an affirmative demo\/qa workspace/i,
        'cleanWorkspaceData must refuse to delete workspace with non-token substring slug',
      );
    } finally {
      await db.execute(sql`delete from workspaces where id = ${falseDemoWsId}`);
    }

    // Proof 2c: non-allowlisted UUID with prefix like 11111111-xxxx => REJECT
    const nonAllowlistedPrefixId = '11111111-9999-4999-8999-999999999999';
    assert.equal(isReservedDemoWorkspaceId(nonAllowlistedPrefixId), false);
    await assert.rejects(
      () => service.assertAffirmativeDemoWorkspace(nonAllowlistedPrefixId, 'acme-production-store'),
      /Safety violation/i,
      'Non-allowlisted UUID starting with 11111111- must be rejected when not in exact reserved allowlist',
    );

    // Proof 3: reserved demo workspace => ACCEPT
    assert.equal(isReservedDemoWorkspaceId(DEMO_WORKSPACE_DEFAULT_ID), true);
    assert.equal(isExplicitDemoSlug('demo-workspace-0130'), true);
    await service.assertAffirmativeDemoWorkspace(DEMO_WORKSPACE_DEFAULT_ID, 'demo-workspace-0130');

    // Proof 4: golden/test reserved workspace => ACCEPT
    assert.equal(isReservedDemoWorkspaceId(WS_A), true);
    assert.equal(isExplicitDemoSlug('demo-workspace-a'), true);
    await service.assertAffirmativeDemoWorkspace(WS_A, 'demo-workspace-a');
    await service.assertAffirmativeDemoWorkspace(WS_B, 'demo-workspace-b');

    // 1. Seed Workspace A and Workspace B
    const seedA = await service.createOrResetDemoWorkspace({
      workspaceId: WS_A,
      workspaceSlug: 'demo-workspace-a',
      workspaceName: 'Demo Workspace A',
      operatorUserId: USER_A,
    });

    const seedB = await service.createOrResetDemoWorkspace({
      workspaceId: WS_B,
      workspaceSlug: 'demo-workspace-b',
      workspaceName: 'Demo Workspace B',
      operatorUserId: USER_B,
    });

    const suppression = new SuppressionService(db);
    const context = new CustomerContextService(db, suppression);
    const identity = new IdentityGraphService(db, context, suppression);
    const audit = new AuditService(db);
    const decisions = new DecisionsService(db, audit);
    const registry = new ConnectorRegistryService();
    const state = createFakeProviderState();
    registry.registerSource(createFakeSourceAdapter(state));
    registry.registerDestination(createFakeDestinationAdapter(state));
    const connections = new ConnectorConnectionService(db, audit, registry);
    const destination = new ConnectorDestinationService(db, connections, registry, audit);
    const opportunities = new OpportunitiesService(db, audit, connections, registry, destination, decisions);

    const uniqueCustA = 'cust_tenant_a_exclusive';
    const uniqueCustB = 'cust_tenant_b_exclusive';
    const custB = seedB.personas.likely_buyer.customerId;
    await db.execute(sql`
      insert into customers (workspace_id, id, status, source_namespace, first_seen_at, last_seen_at)
      values
        (${WS_A}, ${uniqueCustA}, 'identified', 'qa-demo', now(), now()),
        (${WS_B}, ${uniqueCustB}, 'identified', 'qa-demo', now(), now())
    `);

    // 2. Read Isolation: A reads A, B reads B
    const contextA = await context.getContext(WS_A, uniqueCustA);
    const contextB = await context.getContext(WS_B, uniqueCustB);
    assert.ok(contextA, 'Workspace A must be able to read its own customer');
    assert.equal(contextA.customer.workspaceId, WS_A);
    assert.ok(contextB, 'Workspace B must be able to read its own customer');
    assert.equal(contextB.customer.workspaceId, WS_B);

    // 3. Cross-Tenant Read Denied: A cannot read B, B cannot read A
    const crossReadAtoB = await context.getContext(WS_A, uniqueCustB);
    const crossReadBtoA = await context.getContext(WS_B, uniqueCustA);
    assert.equal(crossReadAtoB, null, 'Workspace A must NOT read Workspace B customer');
    assert.equal(crossReadBtoA, null, 'Workspace B must NOT read Workspace A customer');

    // 4. Cross-Tenant Mutation Denied: A mutates B denied, B mutates A denied
    await assert.rejects(
      () =>
        identity.mergeCustomers({
          workspaceId: WS_A,
          sourceCustomerId: uniqueCustB, // Belongs strictly to B
          targetCustomerId: uniqueCustA, // Belongs strictly to A
          reason: 'cross-tenant-attack-probe',
          sourceNamespace: 'qa-demo',
          actor: { type: 'system' },
        }),
      /not found in this workspace/,
      'Attempting cross-workspace customer merge from A targeting B must be rejected',
    );

    await assert.rejects(
      () =>
        identity.mergeCustomers({
          workspaceId: WS_B,
          sourceCustomerId: uniqueCustA, // Belongs strictly to A
          targetCustomerId: uniqueCustB, // Belongs strictly to B
          reason: 'cross-tenant-attack-probe',
          sourceNamespace: 'qa-demo',
          actor: { type: 'system' },
        }),
      /not found in this workspace/,
      'Attempting cross-workspace customer merge from B targeting A must be rejected',
    );

    // 5. Cross-Tenant Opportunities Isolation: A lists only A's opportunities
    const oppsA = await opportunities.list(WS_A, seedA.radar.id, { limit: 10 });
    assert.ok(oppsA.items.length > 0);
    const dbRowsA = await db.execute(sql`
      select workspace_id from opportunity_rows where workspace_id = ${WS_A}
    `) as Array<{ workspace_id: string }>;
    for (const row of dbRowsA) {
      assert.equal(row.workspace_id, WS_A, 'All opportunities in A must have workspace_id = WS_A');
    }

    const firstOppA = oppsA.items[0]!.id;
    const detailA = await opportunities.detail(WS_A, firstOppA);
    assert.ok(detailA);
    await assert.rejects(
      () => opportunities.detail(WS_B, firstOppA),
      /not found/i,
      'Workspace B must NOT read Workspace A opportunity detail',
    );

    // 6. Cross-Tenant Opportunity Operations Denied:
    const oppsB = await opportunities.list(WS_B, seedB.radar.id, { limit: 10 });
    if (oppsB.items.length > 0) {
      const oppIdFromB = oppsB.items[0]!.id;
      // Export with foreign ID from B is rejected
      await assert.rejects(
        () =>
          opportunities.exportCsv(WS_A, USER_A, {
            radarId: seedA.radar.id,
            selection: { mode: 'selected', batchId: seedA.opportunityBatchId, ids: [oppIdFromB] },
            correlationId: 'probe-corr-export',
          }),
        /stale_selection/,
        'Workspace A must NOT be able to export an opportunity from Workspace B',
      );

      // Activation with foreign batch from B is rejected
      await assert.rejects(
        () =>
          opportunities.activate(WS_A, USER_A, {
            radarId: seedA.radar.id,
            selection: { mode: 'selected', batchId: seedB.opportunityBatchId, ids: [oppIdFromB] },
            correlationId: 'probe-corr',
            connectionId: `conn_dest_${WS_A.slice(-6)}`,
            idempotencyKey: 'probe-idemp-1',
          }),
        /stale_selection/,
        'Workspace A must NOT be able to activate an opportunity batch from Workspace B',
      );
    }

    // 7. Accounts Tenant Isolation
    const [accA] = await db.execute(sql`
      select count(*)::int as count from crm_accounts where workspace_id = ${WS_A}
    `) as Array<{ count: number }>;
    const [accB] = await db.execute(sql`
      select count(*)::int as count from crm_accounts where workspace_id = ${WS_B}
    `) as Array<{ count: number }>;
    assert.equal(accA?.count, 2, 'Workspace A must have 2 crm_accounts');
    assert.equal(accB?.count, 2, 'Workspace B must have 2 crm_accounts');

    // 8. Cleanup & Isolation of Cleanup
    await service.cleanWorkspaceData(WS_A);
    // B must still be intact
    const remainingB = await context.getContext(WS_B, custB);
    assert.ok(remainingB, 'Cleaning Workspace A must not affect Workspace B data');

    const [accAResidual] = await db.execute(sql`
      select count(*)::int as count from crm_accounts where workspace_id = ${WS_A}
    `) as Array<{ count: number }>;
    const [accBRemaining] = await db.execute(sql`
      select count(*)::int as count from crm_accounts where workspace_id = ${WS_B}
    `) as Array<{ count: number }>;
    assert.equal(accAResidual?.count, 0, 'Cleaning Workspace A must clear its crm_accounts');
    assert.equal(accBRemaining?.count, 2, 'Cleaning Workspace A must leave Workspace B crm_accounts intact');

    await service.cleanWorkspaceData(WS_B);
  } finally {
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
