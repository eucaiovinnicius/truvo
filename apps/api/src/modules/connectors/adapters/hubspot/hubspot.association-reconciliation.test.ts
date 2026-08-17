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
  crmAccounts,
  crmDeals,
  crmAssociations,
  customers,
  customerIdentifiers,
  customerOutcomes,
} from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { CustomerContextService } from '../../../customer-context/customer-context.service';
import { SuppressionService } from '../../../customer-context/suppression.service';
import { IdentityGraphService } from '../../../identity/identity-graph.service';
import { closeRedis } from '../../../identity/identity.infra';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { CanonicalMappingService } from '../../canonical-mapping';
import { CommerceWriteService } from '../../commerce/commerce-write.service';
import { BillingContextWriteService } from '../../billing/billing-context-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { createHubspotAdapter } from './hubspot.adapter';
import type { HubspotFetch } from './hubspot.api-client';
import { HUBSPOT_PROVIDER } from './hubspot.constants';

/**
 * Order 061 (association + contract closure) — GAP B: "authoritative CRM
 * association convergence." Direct runtime proof, real Postgres, real
 * `IdentityGraphService`/`CrmWriteService.reconcileAssociations`: deal
 * reassociation, contact/company reassociation, out-of-order safety, tenant
 * isolation, and mapped-outcome safety under reassociation.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order061_association_reconciliation_test_key_dev_only';

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
const WS = `test_ws_assoc_${STAMP}`;
const WS_OTHER = `test_ws_assoc_other_${STAMP}`;

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response;
}
function companyNode(id: string, name: string) {
  return { id, properties: { name, hs_lastmodifieddate: String(Date.now()) } };
}
function contactNode(id: string, opts: { companyId?: string } = {}) {
  return {
    id,
    properties: { email: null, phone: null, lifecyclestage: null, hs_lastmodifieddate: String(Date.now()) },
    ...(opts.companyId ? { associations: { companies: { results: [{ id: opts.companyId, type: 'contact_to_company' }] } } } : { associations: { companies: { results: [] } } }),
  };
}
function dealNode(id: string, opts: { stage?: string; amount?: string; contactId?: string; companyId?: string; lastModifiedMs?: number }) {
  const associations: Record<string, { results: Array<{ id: string; type: string }> }> = { contacts: { results: [] }, companies: { results: [] } };
  if (opts.contactId) associations.contacts = { results: [{ id: opts.contactId, type: 'deal_to_contact' }] };
  if (opts.companyId) associations.companies = { results: [{ id: opts.companyId, type: 'deal_to_company' }] };
  return {
    id,
    properties: { dealname: 'Deal', amount: opts.amount ?? '100.00', deal_currency_code: 'USD', dealstage: opts.stage ?? 'open', pipeline: 'default', hs_lastmodifieddate: String(opts.lastModifiedMs ?? Date.now()) },
    associations,
  };
}
function searchPage(results: unknown[]) {
  return jsonResponse({ results });
}

test('HubSpot association reconciliation: authoritative convergence, not accumulation (real Postgres)', async (t) => {
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
  const mapping = new CanonicalMappingService(identityGraph, customerContext, commerce, billing, crm);
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);

  const queue: Response[] = [];
  const fetchImpl: HubspotFetch = (async () => queue.shift() ?? jsonResponse({ results: [] })) as HubspotFetch;
  const adapter = createHubspotAdapter(fetchImpl);
  registry.registerSource(adapter);

  async function newConnection(ws: string, outcomeMappings: unknown[] = []) {
    const conn = await connections.create(ws, {
      provider: HUBSPOT_PROVIDER, role: 'source', displayName: `assoc-${ws}`,
      config: { object_selection: { contacts: { enabled: true, properties: [] }, companies: { enabled: true, properties: [] }, deals: { enabled: true, properties: [] } }, outcome_mappings: outcomeMappings },
    });
    await connections.setCredentials(ws, conn.id, { access_token: 'tok', refresh_token: 'rt', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    return conn;
  }

  try {
    await t.test('deal reassociation converges: old edge tombstoned, new edge active, repeat is idempotent', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([companyNode(`co_a_${STAMP}`, 'Company A'), companyNode(`co_b_${STAMP}`, 'Company B')]));
      await orchestrator.runBackfill(WS, conn.id, 'companies');

      // 1+2. deal D associated with company A; sync persists exactly D→A active.
      queue.push(searchPage([dealNode(`d1_${STAMP}`, { companyId: `co_a_${STAMP}`, lastModifiedMs: 1000 })]));
      await orchestrator.runBackfill(WS, conn.id, 'deals');

      const [dealRow] = await db.select().from(crmDeals).where(and(eq(crmDeals.workspaceId, WS), eq(crmDeals.providerObjectId, `d1_${STAMP}`)));
      const [coA] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_a_${STAMP}`)));
      const [coB] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_b_${STAMP}`)));

      let edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealRow!.id), eq(crmAssociations.toObjectType, 'company')));
      assert.equal(edges.length, 1, 'exactly the active D→A edge after the first sync');
      assert.equal(edges[0]!.toObjectId, coA!.id);
      assert.equal(edges[0]!.deletedAt, null);

      // 3+4. provider state changes: D now associated with B, no longer A. Incremental reconciliation runs.
      queue.push(searchPage([dealNode(`d1_${STAMP}`, { companyId: `co_b_${STAMP}`, lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      // 5+6. active state contains D→B; D→A no longer active.
      edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealRow!.id), eq(crmAssociations.toObjectType, 'company')));
      const activeEdges = edges.filter((e) => e.deletedAt === null);
      assert.equal(activeEdges.length, 1, 'exactly ONE active company edge — converged, not accumulated');
      assert.equal(activeEdges[0]!.toObjectId, coB!.id);
      const oldEdge = edges.find((e) => e.toObjectId === coA!.id);
      assert.ok(oldEdge?.deletedAt, 'D→A is preserved as a TOMBSTONE (auditable), not deleted, and no longer active');

      // 7. repeating the same sync is idempotent.
      queue.push(searchPage([dealNode(`d1_${STAMP}`, { companyId: `co_b_${STAMP}`, lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');
      const edgesAfterRepeat = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealRow!.id), eq(crmAssociations.toObjectType, 'company')));
      assert.equal(edgesAfterRepeat.length, 2, 'no new row created on repeat — same natural key');
      assert.equal(edgesAfterRepeat.filter((e) => e.deletedAt === null).length, 1);
    });

    await t.test('contact/company reassociation converges the same way', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([companyNode(`co_x_${STAMP}`, 'Company X'), companyNode(`co_y_${STAMP}`, 'Company Y')]));
      await orchestrator.runBackfill(WS, conn.id, 'companies');

      queue.push(searchPage([contactNode(`c1_${STAMP}`, { companyId: `co_x_${STAMP}` })]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');

      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c1_${STAMP}`)));
      const [coX] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_x_${STAMP}`)));
      const [coY] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_y_${STAMP}`)));

      let edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'contact'), eq(crmAssociations.fromObjectId, identifier!.customerId), eq(crmAssociations.toObjectType, 'company')));
      assert.equal(edges.filter((e) => e.deletedAt === null).length, 1);
      assert.equal(edges.find((e) => e.deletedAt === null)!.toObjectId, coX!.id);

      queue.push(searchPage([contactNode(`c1_${STAMP}`, { companyId: `co_y_${STAMP}` })]));
      await orchestrator.runIncremental(WS, conn.id, 'contacts');

      edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'contact'), eq(crmAssociations.fromObjectId, identifier!.customerId), eq(crmAssociations.toObjectType, 'company')));
      const active = edges.filter((e) => e.deletedAt === null);
      assert.equal(active.length, 1, 'converged to exactly one active edge');
      assert.equal(active[0]!.toObjectId, coY!.id);
      assert.ok(edges.find((e) => e.toObjectId === coX!.id)?.deletedAt, 'old contact→company edge tombstoned');
    });

    await t.test('out-of-order safety: a stale update cannot resurrect a newer-removed edge', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([companyNode(`co_p_${STAMP}`, 'P'), companyNode(`co_q_${STAMP}`, 'Q')]));
      await orchestrator.runBackfill(WS, conn.id, 'companies');

      // deal starts associated with P at t=1000.
      queue.push(searchPage([dealNode(`d2_${STAMP}`, { companyId: `co_p_${STAMP}`, lastModifiedMs: 1000 })]));
      await orchestrator.runBackfill(WS, conn.id, 'deals');

      // NEWER reassociation to Q at t=5000.
      queue.push(searchPage([dealNode(`d2_${STAMP}`, { companyId: `co_q_${STAMP}`, lastModifiedMs: 5000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      const [dealRow] = await db.select().from(crmDeals).where(and(eq(crmDeals.workspaceId, WS), eq(crmDeals.providerObjectId, `d2_${STAMP}`)));
      const [coQ] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_q_${STAMP}`)));

      // a STALE update (t=2000, older than the t=5000 reconciliation already applied) still reporting P arrives late.
      queue.push(searchPage([dealNode(`d2_${STAMP}`, { companyId: `co_p_${STAMP}`, lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      const edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealRow!.id), eq(crmAssociations.toObjectType, 'company')));
      const active = edges.filter((e) => e.deletedAt === null);
      assert.equal(active.length, 1, 'the stale update must not have changed the active set at all');
      assert.equal(active[0]!.toObjectId, coQ!.id, 'Q (the NEWER truth) must still be the active edge — the stale P update was rejected wholesale');
    });

    await t.test('tenant isolation: identical provider ids in another workspace never cross-mutate', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_OTHER);

      queue.push(searchPage([companyNode(`co_shared_${STAMP}`, 'Shared Co')]));
      await orchestrator.runBackfill(WS, connA.id, 'companies');
      queue.push(searchPage([companyNode(`co_shared_${STAMP}`, 'Shared Co (other ws)')]));
      await orchestrator.runBackfill(WS_OTHER, connB.id, 'companies');

      queue.push(searchPage([dealNode(`d_shared_${STAMP}`, { companyId: `co_shared_${STAMP}`, lastModifiedMs: 1000 })]));
      await orchestrator.runBackfill(WS, connA.id, 'deals');
      queue.push(searchPage([dealNode(`d_shared_${STAMP}`, { lastModifiedMs: 1000 })])); // no association in WS_OTHER
      await orchestrator.runBackfill(WS_OTHER, connB.id, 'deals');

      const [dealA] = await db.select().from(crmDeals).where(and(eq(crmDeals.workspaceId, WS), eq(crmDeals.providerObjectId, `d_shared_${STAMP}`)));
      const [dealB] = await db.select().from(crmDeals).where(and(eq(crmDeals.workspaceId, WS_OTHER), eq(crmDeals.providerObjectId, `d_shared_${STAMP}`)));
      assert.notEqual(dealA!.id, dealB!.id);

      const edgesA = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealA!.id)));
      const edgesB = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS_OTHER), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealB!.id)));
      assert.equal(edgesA.filter((e) => e.deletedAt === null).length, 1, 'WS has an active association');
      assert.equal(edgesB.length, 0, 'WS_OTHER never had one — reconciling WS must not have touched it');

      // reconcile WS again (remove the association there) — WS_OTHER (which never had one) must remain untouched.
      queue.push(searchPage([dealNode(`d_shared_${STAMP}`, { lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, connA.id, 'deals');
      const edgesAAfter = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealA!.id)));
      assert.equal(edgesAAfter.filter((e) => e.deletedAt === null).length, 0, 'WS deal→company edge removed');
      const edgesBAfter = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS_OTHER), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealB!.id)));
      assert.equal(edgesBAfter.length, 0, 'WS_OTHER unaffected by WS reconciliation');
    });

    await t.test('mapped outcome safety: reassociation makes future outcomes use the CURRENT contact, never duplicating the natural outcome', async () => {
      const outcomeMappings = [{ objectType: 'deal', propertyName: 'dealstage', propertyValue: 'closedwon', outcomeNamespace: 'crm', outcomeKey: 'deal_won_reassoc', name: 'Deal Won' }];
      const conn = await newConnection(WS, outcomeMappings);

      queue.push(searchPage([contactNode(`c_own1_${STAMP}`), contactNode(`c_own2_${STAMP}`)]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');
      const [contact1] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_own1_${STAMP}`)));
      const [contact2] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_own2_${STAMP}`)));

      // deal starts open, associated with contact1 — no outcome yet (not closedwon).
      queue.push(searchPage([dealNode(`d_own_${STAMP}`, { stage: 'open', contactId: `c_own1_${STAMP}`, lastModifiedMs: 1000 })]));
      await orchestrator.runBackfill(WS, conn.id, 'deals');
      let outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.outcomeKey, 'deal_won_reassoc')));
      assert.equal(outcomes.length, 0, 'no outcome yet — deal not won');

      // reassociated to contact2, THEN won.
      queue.push(searchPage([dealNode(`d_own_${STAMP}`, { stage: 'closedwon', contactId: `c_own2_${STAMP}`, lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.outcomeKey, 'deal_won_reassoc')));
      assert.equal(outcomes.length, 1, 'exactly one natural outcome for this deal — no duplication');
      assert.equal(outcomes[0]!.customerId, contact2!.customerId, 'the outcome must use the CURRENT (post-reassociation) contact');
      assert.notEqual(outcomes[0]!.customerId, contact1!.customerId, 'never the stale former contact');

      // a repeat sync of the SAME won state must not duplicate the outcome.
      queue.push(searchPage([dealNode(`d_own_${STAMP}`, { stage: 'closedwon', contactId: `c_own2_${STAMP}`, lastModifiedMs: 2000 })]));
      await orchestrator.runIncremental(WS, conn.id, 'deals');
      outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.outcomeKey, 'deal_won_reassoc')));
      assert.equal(outcomes.length, 1, 'still exactly one — idempotent');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(crmAssociations).where(eq(crmAssociations.workspaceId, ws)).catch(() => undefined);
      await db.delete(crmDeals).where(eq(crmDeals.workspaceId, ws)).catch(() => undefined);
      await db.delete(crmAccounts).where(eq(crmAccounts.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
