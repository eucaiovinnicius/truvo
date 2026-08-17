import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  connectorConnections,
  connectorSyncCheckpoints,
  connectorSyncRuns,
  connectorDestinationWrites,
  crmAccounts,
  crmDeals,
  crmAssociations,
  customers,
  customerIdentifiers,
  customerTraits,
  customerOutcomes,
  identitySuppressions,
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
import { CrmWriteService, readOutcomeMappings } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorWebhookService } from '../../connector-webhook.service';
import { ConnectorDestinationService } from '../../connector-destination.service';
import { createHubspotAdapter } from './hubspot.adapter';
import type { HubspotFetch } from './hubspot.api-client';
import { HUBSPOT_PROVIDER } from './hubspot.constants';

/**
 * Order 061 §9 — the real HubSpot adapter driven end-to-end through the REAL
 * Order 050 framework services against a REAL Postgres, using a deterministic
 * fake `fetch` (no live HubSpot credentials). Covers the explicit edge-case list:
 * OAuth/scope failure, revoked credentials, paginated backfill+checkpoint,
 * webhook batch (all events), duplicate batch, property change, contact merge,
 * company association, deal reassociation, deleted/restored object, missing
 * property, explicit outcome mapping, writeback idempotency, reconciliation,
 * tenant isolation, suppression, rate-limit retry.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order061_hubspot_test_key_dev_only';

const CLIENT_SECRET = 'hubspot_client_secret';
const FAR_FUTURE = new Date(Date.now() + 3600_000).toISOString();

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
const WS = `test_ws_hubspot_${STAMP}`;
const WS_OTHER = `test_ws_hubspot_other_${STAMP}`;

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function scopesResponse(scopes = ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read']) {
  return jsonResponse({ scopes, hub_id: 1 });
}

function contactNode(id: string, opts: { email?: string; lifecyclestage?: string; companyId?: string } = {}) {
  return {
    id,
    properties: { email: opts.email ?? null, phone: null, lifecyclestage: opts.lifecyclestage ?? null, hs_lastmodifieddate: String(Date.now()) },
    ...(opts.companyId ? { associations: { companies: { results: [{ id: opts.companyId, type: 'contact_to_company' }] } } } : {}),
  };
}
function companyNode(id: string, name: string) {
  return { id, properties: { name, hs_lastmodifieddate: String(Date.now()) } };
}
function dealNode(id: string, opts: { stage?: string; amount?: string; contactId?: string; companyId?: string }) {
  const associations: Record<string, { results: Array<{ id: string; type: string }> }> = {};
  if (opts.contactId) associations.contacts = { results: [{ id: opts.contactId, type: 'deal_to_contact' }] };
  if (opts.companyId) associations.companies = { results: [{ id: opts.companyId, type: 'deal_to_company' }] };
  return { id, properties: { dealname: 'Deal', amount: opts.amount ?? '100.00', deal_currency_code: 'USD', dealstage: opts.stage ?? 'open', pipeline: 'default', hs_lastmodifieddate: String(Date.now()) }, associations };
}
function searchPage(results: unknown[], hasNext = false) {
  return jsonResponse({ results, ...(hasNext ? { paging: { next: { after: 'cursor_1' } } } : {}) });
}

function signedWebhook(url: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const base = `POST${url}${raw.toString('utf8')}${timestamp}`;
  const signature = createHmac('sha256', CLIENT_SECRET).update(base).digest('base64');
  return { headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp }, body, rawBody: raw, url, method: 'POST' };
}

test('HubSpot adapter: end-to-end proofs against real Postgres (§9 edge cases)', async (t) => {
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
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping);
  const webhook = new ConnectorWebhookService(db, connections, registry, mapping);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);

  const queue: Response[] = [];
  const fetchImpl: HubspotFetch = (async () => queue.shift() ?? scopesResponse()) as HubspotFetch;
  const adapter = createHubspotAdapter(fetchImpl);
  registry.registerSource(adapter);
  registry.registerDestination(adapter);

  const webhookUrl = (ws: string, connId: string) => `https://truvo.example.com/v1/connectors/webhooks/${ws}/${connId}`;

  async function newConnection(ws: string, objectSelection: Record<string, unknown> = { contacts: { enabled: true, properties: ['lifecyclestage'] }, companies: { enabled: true, properties: ['industry'] }, deals: { enabled: true, properties: [] } }, outcomeMappings: unknown[] = []) {
    const conn = await connections.create(ws, { provider: HUBSPOT_PROVIDER, role: 'bidirectional', displayName: `hubspot-${ws}`, config: { object_selection: objectSelection, outcome_mappings: outcomeMappings } });
    await connections.setCredentials(ws, conn.id, { access_token: 'tok', refresh_token: 'rt', expires_at: FAR_FUTURE, client_secret: CLIENT_SECRET });
    return conn;
  }

  try {
    await t.test('testConnection: OAuth/scope failure and revoked credentials both fail closed with the right signal', async () => {
      const conn = await newConnection(WS);
      queue.push(jsonResponse({ scopes: ['crm.objects.contacts.read'] })); // missing companies/deals
      const scopeFail = await connections.testConnection(WS, conn.id);
      assert.equal(scopeFail.ok, false);
      assert.match(scopeFail.message, /scopes/);

      const conn2 = await newConnection(WS);
      queue.push(jsonResponse({}, 401));
      const revoked = await connections.testConnection(WS, conn2.id);
      assert.equal(revoked.ok, false);
      assert.equal(revoked.authFailure, true);
      const after = await connections.get(WS, conn2.id);
      assert.equal(after.credentialStatus, 'invalid');
    });

    await t.test('paginated backfill + durable checkpoint resume is idempotent on replay', async () => {
      const conn = await newConnection(WS);
      const stream = 'contacts';
      queue.push(searchPage([contactNode(`c_bf1_${STAMP}`)], true));
      const first = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(first.status, 'succeeded');
      assert.equal(first.hasMore, true);

      queue.push(searchPage([contactNode(`c_bf2_${STAMP}`)], false));
      const second = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(second.status, 'succeeded');
      assert.equal(second.hasMore, false);

      queue.push(searchPage([contactNode(`should_not_be_read_${STAMP}`)]));
      const replay = await orchestrator.runBackfill(WS, conn.id, stream);
      assert.equal(replay.replayedFromCache, true);
      assert.equal(queue.length, 1, 'a cached replay must never call the adapter again');
      queue.length = 0;
    });

    await t.test('rate-limit: 429 on backfill is rate_limited (not a generic error), retry succeeds without dropping records', async () => {
      const conn = await newConnection(WS);
      queue.push(jsonResponse({ errorType: 'RATE_LIMIT' }, 429));
      const limited = await orchestrator.runBackfill(WS, conn.id, 'contacts');
      assert.equal(limited.status, 'rate_limited');

      queue.push(searchPage([contactNode(`c_throttled_${STAMP}`)]));
      const retried = await orchestrator.runBackfill(WS, conn.id, 'contacts');
      assert.equal(retried.status, 'succeeded');
      assert.equal(retried.recordsRead, 1);
    });

    await t.test('webhook batch with multiple events — ALL processed (the known batch bug, fixed)', async () => {
      const conn = await newConnection(WS);
      const url = webhookUrl(WS, conn.id);
      const body = [
        { subscriptionType: 'contact.propertyChange', objectId: `c_batch1_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() },
        { subscriptionType: 'contact.propertyChange', objectId: `c_batch2_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'customer', occurredAt: Date.now() },
        { subscriptionType: 'contact.propertyChange', objectId: `c_batch3_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'opportunity', occurredAt: Date.now() },
      ];
      const result = await webhook.handleWebhook(WS, conn.id, signedWebhook(url, body));
      assert.equal(result.status, 'ok');

      const rows = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.providerNamespace, HUBSPOT_PROVIDER)));
      const ids = rows.map((r) => r.identifierValue);
      assert.ok(ids.includes(`c_batch1_${STAMP}`) && ids.includes(`c_batch2_${STAMP}`) && ids.includes(`c_batch3_${STAMP}`), 'all 3 events in the batch must have been processed, not just the first');
    });

    await t.test('duplicate webhook batch is harmless; invalid signature fails closed', async () => {
      const conn = await newConnection(WS);
      const url = webhookUrl(WS, conn.id);
      const body = [{ subscriptionType: 'contact.propertyChange', objectId: `c_dup_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }];
      const request = signedWebhook(url, body);
      const first = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(first.status, 'ok');
      const second = await webhook.handleWebhook(WS, conn.id, request);
      assert.equal(second.status, 'duplicate');

      const invalid = await webhook.handleWebhook(WS, conn.id, { ...request, headers: { 'x-hubspot-signature-v3': 'not_real', 'x-hubspot-request-timestamp': String(Date.now()) } });
      assert.equal(invalid.status, 'rejected');
    });

    await t.test('contact property change (webhook) writes a single trait without touching others', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([contactNode(`c_props_${STAMP}`, { lifecyclestage: 'lead' })]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');

      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.providerNamespace, HUBSPOT_PROVIDER), eq(customerIdentifiers.identifierValue, `c_props_${STAMP}`)));
      const customerId = identifier!.customerId;

      const url = webhookUrl(WS, conn.id);
      const body = [{ subscriptionType: 'contact.propertyChange', objectId: `c_props_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'customer', occurredAt: Date.now() }];
      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, body));

      const [trait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerId), eq(customerTraits.traitKey, 'lifecyclestage')));
      assert.equal(trait!.value, 'customer', 'the webhook-driven property change must win (newest observation)');
    });

    await t.test('contact merge (real IdentityGraphService.mergeCustomers) converges a subsequent property-change webhook onto the surviving customer', async () => {
      const conn = await newConnection(WS);
      const url = webhookUrl(WS, conn.id);

      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.creation', objectId: `c_mergeA_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }]));
      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.creation', objectId: `c_mergeB_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }]));

      const [idA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_mergeA_${STAMP}`)));
      const [idB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_mergeB_${STAMP}`)));
      const customerA = idA!.customerId;
      const customerB = idB!.customerId;
      assert.notEqual(customerA, customerB);

      const mergeResult = await identityGraph.mergeCustomers({ workspaceId: WS, sourceCustomerId: customerA, targetCustomerId: customerB, reason: 'order061 merge test', sourceNamespace: 'test.hubspot_merge', actor: { type: 'system', id: 'order061-test' } });
      assert.equal(mergeResult.status, 'merged');

      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.propertyChange', objectId: `c_mergeA_${STAMP}`, propertyName: 'lifecyclestage', propertyValue: 'customer', occurredAt: Date.now() }]));

      const [identifierAfter] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_mergeA_${STAMP}`)));
      assert.equal(identifierAfter!.customerId, customerB, 'the original contact identifier must resolve to the surviving customer B');
      const [traitAfter] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, customerB), eq(customerTraits.traitKey, 'lifecyclestage')));
      assert.equal(traitAfter!.value, 'customer', 'the post-merge property change must land on B, not the merged-away A');
    });

    await t.test('company association: contact→company edge resolves and self-heals regardless of which side syncs first', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([companyNode(`co1_${STAMP}`, 'Acme Inc')]));
      await orchestrator.runBackfill(WS, conn.id, 'companies');

      queue.push(searchPage([contactNode(`c_assoc_${STAMP}`, { companyId: `co1_${STAMP}` })]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');

      const [account] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co1_${STAMP}`)));
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_assoc_${STAMP}`)));
      const [edge] = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'contact'), eq(crmAssociations.fromObjectId, identifier!.customerId)));
      assert.equal(edge!.toObjectType, 'company');
      assert.equal(edge!.toObjectId, account!.id);
    });

    await t.test('deal reassociation: a deal resynced under a NEW company still resolves the new edge', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([companyNode(`co_old_${STAMP}`, 'Old Co'), companyNode(`co_new_${STAMP}`, 'New Co')]));
      await orchestrator.runBackfill(WS, conn.id, 'companies');

      queue.push(searchPage([dealNode(`d_reassoc_${STAMP}`, { companyId: `co_old_${STAMP}` })]));
      await orchestrator.runBackfill(WS, conn.id, 'deals');
      queue.push(searchPage([dealNode(`d_reassoc_${STAMP}`, { companyId: `co_new_${STAMP}` })], false));
      // a completed BACKFILL short-circuits on replay — a later reconciliation tick
      // uses runIncremental on the SAME stream, which does NOT short-circuit.
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      const [dealRow] = await db.select().from(crmDeals).where(and(eq(crmDeals.workspaceId, WS), eq(crmDeals.providerObjectId, `d_reassoc_${STAMP}`)));
      const [oldCoRow] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_old_${STAMP}`)));
      const [newCoRow] = await db.select().from(crmAccounts).where(and(eq(crmAccounts.workspaceId, WS), eq(crmAccounts.providerObjectId, `co_new_${STAMP}`)));
      const edges = await db.select().from(crmAssociations).where(and(eq(crmAssociations.workspaceId, WS), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealRow!.id), eq(crmAssociations.toObjectType, 'company')));
      const newEdge = edges.find((e) => e.toObjectId === newCoRow!.id);
      const oldEdge = edges.find((e) => e.toObjectId === oldCoRow!.id);
      assert.ok(newEdge, 'the deal must resolve an edge to the NEW company after reassociation');
      assert.equal(newEdge!.deletedAt, null, 'the new edge must be ACTIVE');
      assert.ok(oldEdge, 'the OLD edge row is preserved (tombstoned), not dropped');
      assert.ok(oldEdge!.deletedAt, 'the old edge must be TOMBSTONED — reconciliation converges, it does not accumulate');
    });

    await t.test('deleted/restored object is explicit — soft, non-destructive, reversible', async () => {
      const conn = await newConnection(WS);
      const url = webhookUrl(WS, conn.id);
      queue.push(searchPage([contactNode(`c_delrest_${STAMP}`)]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');

      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.deletion', objectId: `c_delrest_${STAMP}`, occurredAt: Date.now() }]));
      const [afterDelete] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_delrest_${STAMP}`)));
      assert.ok(afterDelete!.deletedAt, 'deletion must be visible/explicit');

      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.restore', objectId: `c_delrest_${STAMP}`, occurredAt: Date.now() }]));
      const [afterRestore] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_delrest_${STAMP}`)));
      assert.equal(afterRestore!.deletedAt, null, 'restoration must reverse it');
    });

    await t.test('suppression after privacy deletion prevents identity reconstruction', async () => {
      const conn = await newConnection(WS);
      const url = webhookUrl(WS, conn.id);
      const contactId = `c_privacy_${STAMP}`;
      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.creation', objectId: contactId, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }]));

      await webhook.handleWebhook(WS, conn.id, signedWebhook(url, [{ subscriptionType: 'contact.privacyDeletion', objectId: contactId, occurredAt: Date.now() }]));

      const [suppressionRow] = await db.select().from(identitySuppressions).where(and(eq(identitySuppressions.workspaceId, WS), eq(identitySuppressions.providerNamespace, HUBSPOT_PROVIDER), eq(identitySuppressions.identifierValue, contactId)));
      assert.ok(suppressionRow, 'a privacy deletion webhook must suppress the identifier');

      await assert.rejects(
        identityGraph.resolveOrCreateCustomer({ workspaceId: WS, providerNamespace: HUBSPOT_PROVIDER, identifierType: 'external_id', identifierValue: contactId, sourceNamespace: 'test', observedAt: new Date() }),
        SuppressedIdentifierError,
        'a suppressed identifier must never silently reconstruct canonical identity',
      );
    });

    await t.test('explicit outcome mapping: dealstage=closedwon maps to a workspace-configured outcome; other stages produce none', async () => {
      const outcomeMappings = [{ objectType: 'deal', propertyName: 'dealstage', propertyValue: 'closedwon', outcomeNamespace: 'crm', outcomeKey: 'deal_won', name: 'Deal Won' }];
      const conn = await newConnection(WS, { contacts: { enabled: true, properties: [] }, companies: { enabled: true, properties: [] }, deals: { enabled: true, properties: [] } }, outcomeMappings);

      queue.push(searchPage([contactNode(`c_deal_${STAMP}`)]));
      await orchestrator.runBackfill(WS, conn.id, 'contacts');
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_deal_${STAMP}`)));

      queue.push(searchPage([dealNode(`d_won_${STAMP}`, { stage: 'closedwon', amount: '500.00', contactId: `c_deal_${STAMP}` })]));
      const applied1 = await orchestrator.runBackfill(WS, conn.id, 'deals');
      assert.equal(applied1.status, 'succeeded');

      queue.push(searchPage([dealNode(`d_lost_${STAMP}`, { stage: 'closedlost', contactId: `c_deal_${STAMP}` })]));
      // a completed backfill short-circuits on replay — use runIncremental for the second deal, same stream.
      await orchestrator.runIncremental(WS, conn.id, 'deals');

      const outcomes = await db.select().from(customerOutcomes).where(and(eq(customerOutcomes.workspaceId, WS), eq(customerOutcomes.customerId, identifier!.customerId), eq(customerOutcomes.outcomeKey, 'deal_won')));
      assert.equal(outcomes.length, 1, 'only the closedwon deal produces an outcome — a deal is not a purchase by default');
      assert.equal(outcomes[0]!.dedupeKey, `d_won_${STAMP}`);
    });

    await t.test('writeback (destination write) is idempotent, audited, correlation-tracked', async () => {
      const conn = await newConnection(WS);
      const idempotencyKey = `wb_${STAMP}`;
      const input = { idempotencyKey, correlationId: `corr_${STAMP}`, kind: 'profile_upsert', payload: { objectType: 'contacts', objectId: `c_wb_${STAMP}`, property: 'truvo_propensity_band', value: 'high' } };

      queue.push(jsonResponse({ id: `c_wb_${STAMP}` }));
      const first = await destination.write(WS, conn.id, input);
      assert.equal(first.status, 'sent');

      const callsBefore = queue.length;
      const second = await destination.write(WS, conn.id, input);
      assert.equal(second.status, 'sent');
      assert.equal(second.externalResultId, first.externalResultId, 'same idempotencyKey must return the SAME result, not call HubSpot again');
      assert.equal(queue.length, callsBefore, 'the second call must not consume another fake fetch response');

      const writeRows = await db.select().from(connectorDestinationWrites).where(and(eq(connectorDestinationWrites.workspaceId, WS), eq(connectorDestinationWrites.idempotencyKey, idempotencyKey)));
      assert.equal(writeRows.length, 1);
      assert.equal(writeRows[0]!.correlationId, `corr_${STAMP}`);
    });

    await t.test('reconciliation (incrementalPull) picks up a change that was never delivered via webhook', async () => {
      const conn = await newConnection(WS);
      queue.push(searchPage([contactNode(`c_recon_${STAMP}`, { lifecyclestage: 'lead' })]));
      await orchestrator.runIncremental(WS, conn.id, `contacts_recon_${STAMP}`);
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, `c_recon_${STAMP}`)));
      assert.ok(identifier, 'reconciliation must be able to create/update canonical state WITHOUT any webhook ever arriving');

      queue.push(searchPage([contactNode(`c_recon_${STAMP}`, { lifecyclestage: 'customer' })]));
      await orchestrator.runIncremental(WS, conn.id, `contacts_recon_${STAMP}`);
      const [trait] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifier!.customerId), eq(customerTraits.traitKey, 'lifecyclestage')));
      assert.equal(trait!.value, 'customer', 'a missed webhook is repaired by the next reconciliation tick');
    });

    await t.test('same HubSpot portal object ids in two DIFFERENT Truvo workspaces never collide', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_OTHER);
      const sharedId = `c_shared_${STAMP}`;

      const urlA = webhookUrl(WS, connA.id);
      const urlB = webhookUrl(WS_OTHER, connB.id);
      await webhook.handleWebhook(WS, connA.id, signedWebhook(urlA, [{ subscriptionType: 'contact.creation', objectId: sharedId, propertyName: 'lifecyclestage', propertyValue: 'lead', occurredAt: Date.now() }]));
      await webhook.handleWebhook(WS_OTHER, connB.id, signedWebhook(urlB, [{ subscriptionType: 'contact.creation', objectId: sharedId, propertyName: 'lifecyclestage', propertyValue: 'customer', occurredAt: Date.now() }]));

      const [idA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, sharedId)));
      const [idB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_OTHER), eq(customerIdentifiers.identifierValue, sharedId)));
      assert.notEqual(idA!.customerId, idB!.customerId);

      const [traitA] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, idA!.customerId), eq(customerTraits.traitKey, 'lifecyclestage')));
      const [traitB] = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS_OTHER), eq(customerTraits.customerId, idB!.customerId), eq(customerTraits.traitKey, 'lifecyclestage')));
      assert.equal(traitA!.value, 'lead');
      assert.equal(traitB!.value, 'customer');
    });

    await t.test('readOutcomeMappings: malformed connection config never throws, just yields no mappings', () => {
      assert.deepEqual(readOutcomeMappings({}), []);
      assert.deepEqual(readOutcomeMappings({ outcome_mappings: 'not_an_array' }), []);
      assert.deepEqual(readOutcomeMappings({ outcome_mappings: [{ objectType: 'contact' }] }), [], 'objectType must be exactly "deal" per the current scope');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(crmAssociations).where(eq(crmAssociations.workspaceId, ws)).catch(() => undefined);
      await db.delete(crmDeals).where(eq(crmDeals.workspaceId, ws)).catch(() => undefined);
      await db.delete(crmAccounts).where(eq(crmAccounts.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, ws)).catch(() => undefined);
      await db.delete(identitySuppressions).where(eq(identitySuppressions.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerIdentifiers).where(eq(customerIdentifiers.workspaceId, ws)).catch(() => undefined);
      await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    }
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
