import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  connectorConnections,
  connectorSyncCheckpoints,
  connectorSyncRuns,
  customers,
  customerIdentifiers,
  customerTraits,
  identitySuppressions,
  engagementEvents,
} from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService, SuppressedIdentifierError } from '../../../identity/identity-graph.service';
import { closeRedis } from '../../../identity/identity.infra';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { EngagementWriteService } from '../../engagement/engagement-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import type { KlaviyoFetch } from './klaviyo.api-client';
import { KLAVIYO_PROVIDER } from './klaviyo.constants';

/**
 * Order 063 — the one edge case not directly exercised by
 * `klaviyo.adapter.contract.test.ts`: a Klaviyo identity whose canonical
 * customer gets MERGED (via the real Order 45 `IdentityGraphService.mergeCustomers`,
 * never by editing an id directly) must converge onto the surviving customer on
 * the next sync, with no split/duplicate engagement state left behind. Mirrors
 * `stripe.customer-merge.test.ts`'s structure. Also covers privacy suppression
 * (Order 55) and tenant isolation under merge. Klaviyo's restricted System
 * Webhooks API is not enabled for Truvo, so every scenario here goes through
 * `ConnectorSyncOrchestratorService.runBackfill`/`runIncremental` instead of
 * `ConnectorWebhookService.handleWebhook`.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order063_klaviyo_merge_verification_test_key_dev_only';
process.env.KLAVIYO_CLIENT_ID ??= 'klaviyo_test_client_id_merge';
process.env.KLAVIYO_CLIENT_SECRET ??= 'klaviyo_test_client_secret_merge';
process.env.KLAVIYO_OAUTH_STATE_SECRET ??= 'order063_klaviyo_merge_oauth_state_secret';

const ACCOUNT_ID = 'acct_order063_merge_test';

let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.DATABASE_URL;
  if (!url) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(url, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
  return reachable;
}

const STAMP = Date.now();
const WS = `test_ws_klaviyo_merge_${STAMP}`;
const WS_OTHER = `test_ws_klaviyo_merge_other_${STAMP}`;

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response;
}
function profileNode(id: string, opts: { email?: string; properties?: Record<string, unknown> } = {}) {
  return { id, attributes: { email: opts.email, properties: opts.properties ?? {}, updated: new Date().toISOString() } };
}
function profilesPage(nodes: unknown[]) {
  return jsonResponse({ data: nodes, links: { next: null } });
}
function eventNode(id: string, opts: { metricId: string; profileId: string; datetime?: string }) {
  return { id, attributes: { datetime: opts.datetime ?? new Date().toISOString(), event_properties: {} }, relationships: { metric: { data: { id: opts.metricId } }, profile: { data: { id: opts.profileId } } } };
}
function metricNode(id: string, name: string) {
  return { type: 'metric', id, attributes: { name } };
}
function eventsPage(nodes: unknown[], metrics: unknown[]) {
  return jsonResponse({ data: nodes, included: metrics, links: { next: null } });
}

async function cleanup(db: ReturnType<typeof createDb>, ws: string) {
  await db.delete(engagementEvents).where(eq(engagementEvents.workspaceId, ws)).catch(() => undefined);
  await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
  await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
  await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
  await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
  await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, ws)).catch(() => undefined);
  await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
  await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
}

test('Klaviyo + Identity Graph v2: customer merge convergence (real Postgres, real mergeCustomers)', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const registry = new ConnectorRegistryService();
  const connections = new ConnectorConnectionService(db, audit, registry);
  const commerce = new CommerceWriteService(db, customerContext);
  const billing = new BillingContextWriteService(db, customerContext);
  const crm = new CrmWriteService(db, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm, new EngagementWriteService(db, customerContext));

  const queue: Response[] = [];
  const fetchImpl: KlaviyoFetch = (async () => queue.shift() ?? jsonResponse({ data: [], links: { next: null } })) as KlaviyoFetch;
  const registryAdapter = createKlaviyoAdapter(fetchImpl);
  registry.registerSource(registryAdapter);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);

  async function newConnection(ws: string) {
    const conn = await connections.create(ws, { provider: KLAVIYO_PROVIDER, role: 'source', displayName: `klaviyo-merge-${ws}` });
    await connections.setCredentials(ws, conn.id, { access_token: 'test_access_token', refresh_token: 'test_refresh', klaviyo_account_id: ACCOUNT_ID });
    return conn;
  }

  const profileA = `kp_merge_a_${STAMP}`;
  const profileB = `kp_merge_b_${STAMP}`;
  const metricOpen = `metric_merge_open_${STAMP}`;
  const metricClick = `metric_merge_click_${STAMP}`;

  try {
    const conn = await newConnection(WS);

    // 1. Klaviyo identity #1 (profileA) resolves to canonical customer A.
    queue.push(profilesPage([profileNode(profileA, { email: `${profileA}@example.com` })]));
    const step1 = await orchestrator.runBackfill(WS, conn.id, 'profiles');
    assert.equal(step1.status, 'succeeded');
    const [identifierABefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileA)));
    const customerA = identifierABefore!.customerId;

    // 2. Klaviyo identity #2 (profileB) resolves to a SEPARATE canonical customer B.
    // A second `runBackfill` on the SAME connection/stream would short-circuit from
    // cache (checkpoint already 'completed' from step 1) — `runIncremental` actually
    // exercises a second real pull on the same connection.
    queue.push(profilesPage([profileNode(profileB, { email: `${profileB}@example.com` })]));
    const step2 = await orchestrator.runIncremental(WS, conn.id, 'profiles');
    assert.equal(step2.status, 'succeeded');
    const [identifierBBefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileB)));
    const customerB = identifierBBefore!.customerId;
    assert.notEqual(customerA, customerB, 'the two Klaviyo identities must start as two DIFFERENT canonical customers');

    // B has one engagement event of its own BEFORE the merge. `EngagementWriteService.upsertEvent`
    // is insert-once (`onConflictDoNothing`) by design (Order 063: engagement events are
    // immutable append-only facts, never updated in place) — so this pre-merge row's own
    // customerId is fixed at insert time and is NOT retroactively rewritten by a later merge.
    // That is intentional and does not need proving here; what Order 063's own required-proof
    // list actually asks for is "profile merge followed by later Klaviyo event" (below).
    const evtBBefore = `kev_merge_b_before_${STAMP}`;
    queue.push(eventsPage([eventNode(evtBBefore, { metricId: metricClick, profileId: profileB })], [metricNode(metricClick, 'Clicked Email')]));
    await orchestrator.runIncremental(WS, conn.id, 'events');

    // 3. Real Order 45 merge: A -> B. NEVER editing customer ids directly.
    const mergeResult = await identityGraph.mergeCustomers({
      workspaceId: WS,
      sourceCustomerId: customerA!,
      targetCustomerId: customerB!,
      reason: 'order063 klaviyo merge verification test',
      sourceNamespace: 'test.klaviyo_merge_verification',
      actor: { type: 'system', id: 'order063-test' },
    });
    assert.equal(mergeResult.status, 'merged');

    const [customerARow] = await db.select().from(customers).where(and(eq(customers.workspaceId, WS), eq(customers.id, customerA!)));
    assert.equal(customerARow!.status, 'merged');
    assert.equal(customerARow!.mergedIntoCustomerId, customerB);

    const [identifierAAfterMerge] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileA)));
    assert.equal(identifierAAfterMerge!.customerId, customerB, 'profileA must resolve to the surviving customer B immediately after the merge');

    // 4. A LATER Klaviyo event for the ORIGINAL (A-side) identifier, synced AFTER the merge.
    const evtAAfter = `kev_merge_a_after_${STAMP}`;
    queue.push(eventsPage([eventNode(evtAAfter, { metricId: metricOpen, profileId: profileA })], [metricNode(metricOpen, 'Opened Email')]));
    await orchestrator.runIncremental(WS, conn.id, 'events');

    // --- Assertions -------------------------------------------------------

    await t.test('the original Klaviyo profile identifier now resolves to the surviving customer B', async () => {
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileA)));
      assert.equal(identifier!.customerId, customerB);
    });

    await t.test('the post-merge event for profileA has customer_id = B, not a duplicate row', async () => {
      const rows = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, evtAAfter)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB, 'a post-merge event for the A-side identity must attach to the surviving customer B');
    });

    await t.test('derived engagement traits on B reflect BOTH its own pre-merge event and the new post-merge event from the merged-away A identity', async () => {
      const [countsTrait] = await db
        .select()
        .from(customerTraits)
        .where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB!), eq(customerTraits.traitNamespace, 'engagement'), eq(customerTraits.traitKey, 'event_counts_by_kind')));
      assert.ok(countsTrait, 'B must have derived engagement traits after the merge');
      const counts = countsTrait!.value as Record<string, number>;
      // evtBBefore (B's own, pre-merge) + evtAAfter (A-side identity, synced AFTER
      // the merge — correctly resolves and attaches directly to B at insert time).
      assert.equal(counts.opened, 1, 'B must count the post-merge event synced through the (now-merged) A-side identity');
      assert.equal(counts.clicked, 1, 'B must still count its own pre-merge event');
    });

    await t.test('replay is idempotent: resending the post-merge event again does not duplicate or diverge state', async () => {
      queue.push(eventsPage([eventNode(evtAAfter, { metricId: metricOpen, profileId: profileA })], [metricNode(metricOpen, 'Opened Email')]));
      await orchestrator.runIncremental(WS, conn.id, 'events');
      const rows = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, evtAAfter)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customerB);
    });
  } finally {
    await cleanup(db, WS);
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});

test('Klaviyo: Truvo privacy suppression prevents identity reconstruction; tenant isolation holds under merge', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const audit = new AuditService(db);
  const suppression = new SuppressionService(db);
  const customerContext = new CustomerContextService(db, suppression);
  const identityGraph = new IdentityGraphService(db, customerContext, suppression);
  const registry = new ConnectorRegistryService();
  const connections = new ConnectorConnectionService(db, audit, registry);
  const commerce = new CommerceWriteService(db, customerContext);
  const billing = new BillingContextWriteService(db, customerContext);
  const crm = new CrmWriteService(db, suppression);
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm, new EngagementWriteService(db, customerContext));

  const queue: Response[] = [];
  const fetchImpl: KlaviyoFetch = (async () => queue.shift() ?? jsonResponse({ data: [], links: { next: null } })) as KlaviyoFetch;
  registry.registerSource(createKlaviyoAdapter(fetchImpl));
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);

  async function newConnection(ws: string, config: Record<string, unknown> = {}) {
    const conn = await connections.create(ws, { provider: KLAVIYO_PROVIDER, role: 'source', displayName: `klaviyo-priv-${ws}-${Date.now()}-${Math.random()}`, config });
    await connections.setCredentials(ws, conn.id, { access_token: 'test_access_token', refresh_token: 'test_refresh', klaviyo_account_id: ACCOUNT_ID });
    return conn;
  }

  try {
    await t.test('suppressing a Klaviyo-linked identifier prevents canonical identity from being silently recreated on a later replay', async () => {
      const conn = await newConnection(WS);
      const profileId = `kp_priv_${STAMP}`;

      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com` })]));
      const first = await orchestrator.runBackfill(WS, conn.id, 'profiles');
      assert.equal(first.status, 'succeeded');
      const [identifierBefore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileId)));
      assert.ok(identifierBefore, 'the identifier must exist before suppression');

      // Order 55 — suppress directly via SuppressionService (Klaviyo has no
      // provider-native "privacy deletion" signal of its own on this connector's
      // scope; the erasure signal comes from Truvo's own data-lifecycle
      // subject-erasure flow, which is exactly what SuppressionService.suppress models).
      await suppression.suppress(WS, { providerNamespace: KLAVIYO_PROVIDER, identifierType: 'external_id', identifierValue: profileId }, { reason: 'order063 privacy suppression test' });

      const [suppressionRow] = await db.select().from(identitySuppressions).where(and(eq(identitySuppressions.workspaceId, WS), eq(identitySuppressions.providerNamespace, KLAVIYO_PROVIDER), eq(identitySuppressions.identifierValue, profileId)));
      assert.ok(suppressionRow, 'the identifier must be suppressed');

      await assert.rejects(
        identityGraph.resolveOrCreateCustomer({ workspaceId: WS, providerNamespace: KLAVIYO_PROVIDER, identifierType: 'external_id', identifierValue: profileId, sourceNamespace: 'test', observedAt: new Date() }),
        SuppressedIdentifierError,
        'a suppressed identifier must never silently reconstruct canonical identity',
      );

      // Replay a historical profile update for the SAME identifier through the
      // real backfill path — the record must be skipped (suppressed), not
      // silently recreate a live customer/identifier.
      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com`, properties: { plan: 'reactivated' } })]));
      const replay = await orchestrator.runIncremental(WS, conn.id, 'profiles');
      assert.equal(replay.status, 'succeeded', 'the sync itself succeeds — the identifier is just skipped inside canonical mapping');

      const identifierRowsAfter = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileId)));
      assert.equal(identifierRowsAfter.length, 1, 'no duplicate/new identifier row was created for the suppressed identifier');
      assert.equal(identifierRowsAfter[0]!.customerId, identifierBefore!.customerId, 'no NEW customer was silently created/reattached for the suppressed identifier');

      // A later engagement event for the SAME suppressed profile stays durable but
      // UNATTACHED (customerId null) — never silently reattached to a reconstructed identity.
      const evtId = `kev_priv_${STAMP}`;
      const metricId = `metric_priv_${STAMP}`;
      queue.push(eventsPage([eventNode(evtId, { metricId, profileId })], [metricNode(metricId, 'Opened Email')]));
      await orchestrator.runIncremental(WS, conn.id, 'events');
      const [eventRow] = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, evtId)));
      assert.ok(eventRow, 'the engagement fact itself is still durably recorded — suppression governs canonical IDENTITY attachment, not whether the fact is lost');
      assert.equal(eventRow!.customerId, null, 'the event must stay UNATTACHED, never silently reattached to a reconstructed identity');
    });

    await t.test('tenant isolation: identical Klaviyo profile ids in two workspaces stay independent; a merge in one workspace never touches the other', async () => {
      const connA = await newConnection(WS, { profile_properties: ['plan'] });
      const connB = await newConnection(WS_OTHER, { profile_properties: ['plan'] });
      const sharedProfile = `kp_iso_${STAMP}`;

      queue.push(profilesPage([profileNode(sharedProfile, { email: `${sharedProfile}@example.com`, properties: { plan: 'ws_a' } })]));
      await orchestrator.runBackfill(WS, connA.id, 'profiles');
      queue.push(profilesPage([profileNode(sharedProfile, { email: `${sharedProfile}@example.com`, properties: { plan: 'ws_b' } })]));
      await orchestrator.runBackfill(WS_OTHER, connB.id, 'profiles');

      const [idA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, sharedProfile)));
      const [idB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_OTHER), eq(customerIdentifiers.identifierValue, sharedProfile)));
      assert.notEqual(idA!.customerId, idB!.customerId);

      const traitsA = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, idA!.customerId)));
      const traitsB = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS_OTHER), eq(customerTraits.customerId, idB!.customerId)));
      assert.ok(traitsA.some((tr) => tr.value === 'ws_a'));
      assert.ok(traitsB.some((tr) => tr.value === 'ws_b'));
      assert.equal(traitsA.some((tr) => tr.value === 'ws_b'), false, 'WS must never see WS_OTHER\'s trait value');
    });
  } finally {
    await cleanup(db, WS);
    await cleanup(db, WS_OTHER);
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
