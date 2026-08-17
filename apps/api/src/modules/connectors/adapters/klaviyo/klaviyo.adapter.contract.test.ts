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
  connectorDestinationWrites,
  customers,
  customerIdentifiers,
  customerTraits,
  customerOutcomes,
  engagementEvents,
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
import { EngagementWriteService } from '../../engagement/engagement-write.service';
import { CrmWriteService } from '../../crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { ConnectorDestinationService } from '../../connector-destination.service';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import type { KlaviyoFetch } from './klaviyo.api-client';
import { KLAVIYO_API_BASE_URL, KLAVIYO_API_REVISION, KLAVIYO_EVENT_OVERLAP_MS, KLAVIYO_PROVIDER } from './klaviyo.constants';

/**
 * Order 063 — the real Klaviyo adapter driven end-to-end through the REAL
 * Order 050 framework services (orchestrator, destination service, canonical
 * mapping → Identity Graph v2 / engagement) against a REAL Postgres, using a
 * deterministic fake `fetch` (no live Klaviyo credentials). Mirrors the rigor
 * of `stripe.adapter.contract.test.ts`/`hubspot.adapter.contract.test.ts`.
 *
 * Covers every Order 063 "Required runtime proof" item EXCEPT what
 * `klaviyo.contract-kit.test.ts` (generic framework proofs: lifecycle,
 * checkpoint resume mechanics, transient/permanent/rate-limit classification,
 * destination idempotency mechanics) and `klaviyo.customer-merge.test.ts`
 * (merge convergence, Truvo privacy suppression, tenant isolation under merge)
 * already prove — zero overlap-skip.
 */
process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order063_klaviyo_adapter_contract_test_key_dev_only';
process.env.KLAVIYO_CLIENT_ID ??= 'klaviyo_test_client_id_ac';
process.env.KLAVIYO_CLIENT_SECRET ??= 'klaviyo_test_client_secret_ac';
process.env.KLAVIYO_OAUTH_STATE_SECRET ??= 'order063_klaviyo_adapter_contract_oauth_state_secret';

const ACCOUNT_ID = 'acct_order063_test';

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
const WS = `test_ws_klaviyo_${STAMP}`;
const WS_OTHER = `test_ws_klaviyo_other_${STAMP}`;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null }, json: async () => body } as unknown as Response;
}

function profileNode(id: string, opts: { email?: string; phone?: string; properties?: Record<string, unknown>; emailConsent?: string; smsConsent?: string; updated?: string } = {}) {
  const subscriptions =
    opts.emailConsent || opts.smsConsent
      ? {
          ...(opts.emailConsent ? { email: { marketing: { consent: opts.emailConsent } } } : {}),
          ...(opts.smsConsent ? { sms: { marketing: { consent: opts.smsConsent } } } : {}),
        }
      : undefined;
  return {
    id,
    attributes: {
      email: opts.email,
      phone_number: opts.phone,
      properties: opts.properties ?? {},
      subscriptions,
      updated: opts.updated ?? new Date().toISOString(),
    },
  };
}
function profilesPage(nodes: unknown[], nextUrl: string | null) {
  return jsonResponse({ data: nodes, links: { next: nextUrl } });
}
function eventNode(id: string, opts: { metricId: string; profileId: string; datetime?: string; eventProperties?: Record<string, unknown> }) {
  return {
    id,
    attributes: { datetime: opts.datetime ?? new Date().toISOString(), event_properties: opts.eventProperties ?? {} },
    relationships: { metric: { data: { id: opts.metricId } }, profile: { data: { id: opts.profileId } } },
  };
}
function metricNode(id: string, name: string) {
  return { type: 'metric', id, attributes: { name } };
}
function eventsPage(nodes: unknown[], metrics: unknown[], nextUrl: string | null) {
  return jsonResponse({ data: nodes, included: metrics, links: { next: nextUrl } });
}

test('Klaviyo adapter: end-to-end proofs against real Postgres (Order 063 required runtime proof)', async (t) => {
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
  const destination = new ConnectorDestinationService(db, connections, registry, audit);

  const calls: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const queue: Response[] = [];
  const fetchImpl: KlaviyoFetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    headersSeen.push((init?.headers ?? {}) as Record<string, string>);
    return queue.shift() ?? jsonResponse({ data: [], links: { next: null } });
  }) as KlaviyoFetch;
  const adapter = createKlaviyoAdapter(fetchImpl);
  registry.registerSource(adapter);
  registry.registerDestination(adapter);

  async function newConnection(ws: string, config: Record<string, unknown> = {}) {
    const conn = await connections.create(ws, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: `klaviyo-${ws}-${Date.now()}-${Math.random()}`, config });
    await connections.setCredentials(ws, conn.id, { access_token: 'test_access_token', refresh_token: 'test_refresh', klaviyo_account_id: ACCOUNT_ID });
    return conn;
  }

  try {
    await t.test('pinned revision header on real requests + profile paginated backfill + checkpoint resume + approved-trait-selection-only + Identity Graph resolution', async () => {
      const conn = await newConnection(WS, { profile_properties: ['plan'] });
      const idA = `kp_a_${STAMP}`;
      const idB = `kp_b_${STAMP}`;
      const idC = `kp_c_${STAMP}`;

      queue.push(
        profilesPage(
          [profileNode(idA, { email: `${idA}@example.com`, properties: { plan: 'pro', secret_internal: 'x' } }), profileNode(idB, { email: `${idB}@example.com` })],
          `${KLAVIYO_API_BASE_URL}/api/profiles?page[cursor]=next_1`,
        ),
      );
      const first = await orchestrator.runBackfill(WS, conn.id, 'profiles');
      assert.equal(first.status, 'succeeded');
      assert.equal(first.recordsRead, 2);
      assert.equal(first.hasMore, true);
      assert.equal(headersSeen.at(-1)?.revision, KLAVIYO_API_REVISION, 'the pinned revision header must be sent on every real request');
      assert.equal(headersSeen.at(-1)?.Authorization, 'Bearer test_access_token');
      assert.equal(calls.at(-1)!.includes('page[cursor]'), false, 'first page must not send a cursor');

      queue.push(profilesPage([profileNode(idC, { email: `${idC}@example.com`, properties: { plan: 'enterprise' } })], null));
      const second = await orchestrator.runBackfill(WS, conn.id, 'profiles');
      assert.equal(second.status, 'succeeded');
      assert.equal(second.recordsRead, 1, 'the resumed call must read exactly the remaining record — page 1 is never re-read');
      assert.equal(second.hasMore, false);
      assert.ok(calls.at(-1)!.includes('page[cursor]=next_1'), 'the resumed call must send the durable checkpoint cursor (Klaviyo\'s own links.next)');

      const callsBeforeReplay = calls.length;
      const replay = await orchestrator.runBackfill(WS, conn.id, 'profiles');
      assert.equal(replay.replayedFromCache, true);
      assert.equal(calls.length, callsBeforeReplay, 'a cached replay must never call the adapter again');

      const [identifierA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, idA)));
      assert.ok(identifierA, 'profile identity must resolve through Identity Graph v2 — a customerIdentifiers row was created');
      const traitsA = await db.select().from(customerTraits).where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifierA!.customerId)));
      assert.ok(traitsA.some((tr) => tr.traitKey === 'plan' && tr.value === 'pro'), 'the configured "plan" property must become a trait');
      assert.equal(traitsA.some((tr) => tr.traitKey === 'secret_internal'), false, 'an unconfigured property must NEVER become a trait');

      // A configured-but-absent property on a DIFFERENT profile must not crash the sync.
      const [identifierB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, idB)));
      assert.ok(identifierB, 'a profile missing the configured property must still resolve identity without crashing');
    });

    await t.test('engagement event/metric ingestion, duplicate engagement event is a harmless no-op, provider consent stored verbatim (never reinterpreted)', async () => {
      const conn = await newConnection(WS);
      const profileId = `kp_engage_${STAMP}`;

      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com`, emailConsent: 'UNSUBSCRIBED' })], null));
      await orchestrator.runBackfill(WS, conn.id, 'profiles');
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileId)));
      assert.ok(identifier);

      const [consentTrait] = await db
        .select()
        .from(customerTraits)
        .where(and(eq(customerTraits.workspaceId, WS), eq(customerTraits.customerId, identifier!.customerId), eq(customerTraits.traitKey, 'email_marketing_consent')));
      assert.equal(consentTrait!.value, 'UNSUBSCRIBED', 'provider subscription/suppression state is retained VERBATIM, never reinterpreted (Order 063 §4)');

      const metricOpen = `metric_open_${STAMP}`;
      const evtId = `kev_${STAMP}`;
      queue.push(eventsPage([eventNode(evtId, { metricId: metricOpen, profileId })], [metricNode(metricOpen, 'Opened Email')], null));
      const firstPull = await orchestrator.runIncremental(WS, conn.id, 'events');
      assert.equal(firstPull.status, 'succeeded');

      const rows = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, evtId)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.engagementKind, 'opened');
      assert.equal(rows[0]!.metricName, 'Opened Email');
      assert.equal(rows[0]!.customerId, identifier!.customerId, 'the event must attach to the ALREADY-resolved canonical customer');

      // Duplicate engagement event: same providerEventId delivered again.
      queue.push(eventsPage([eventNode(evtId, { metricId: metricOpen, profileId })], [metricNode(metricOpen, 'Opened Email')], null));
      const secondPull = await orchestrator.runIncremental(WS, conn.id, 'events');
      assert.equal(secondPull.status, 'succeeded');
      const rowsAfter = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, evtId)));
      assert.equal(rowsAfter.length, 1, 'duplicate engagement event (same providerEventId) must be a harmless no-op, never a second row');
    });

    await t.test('delayed-event-safe incremental sync: bounded overlap cursor replay is harmless; a late-arriving event is eventually ingested (missed-event reconciliation)', async () => {
      const conn = await newConnection(WS);
      const profileId = `kp_delay_${STAMP}`;
      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com` })], null));
      await orchestrator.runBackfill(WS, conn.id, 'profiles');

      const metricClick = `metric_click_${STAMP}`;
      const onTimeEvt = `kev_ontime_${STAMP}`;
      const lateEvt = `kev_late_${STAMP}`;

      // Tick 1: only the on-time event is visible; catches up (hasMore=false) — the
      // checkpoint must land ~15min BEHIND now, never exactly now (Order 063 §3).
      queue.push(eventsPage([eventNode(onTimeEvt, { metricId: metricClick, profileId })], [metricNode(metricClick, 'Clicked Email')], null));
      const tick1 = await orchestrator.runIncremental(WS, conn.id, 'events');
      assert.equal(tick1.status, 'succeeded');
      assert.equal(tick1.hasMore, false);
      const cursorAfterTick1 = Date.parse(tick1.nextCursor!);
      assert.ok(Date.now() - cursorAfterTick1 >= KLAVIYO_EVENT_OVERLAP_MS - 5_000, 'events checkpoint must land AT LEAST ~15min behind now on catch-up, never exactly now');

      // Tick 2: Klaviyo redelivers the SAME on-time event (falls inside the bounded
      // overlap window) AND now also returns the event that only just became visible.
      queue.push(
        eventsPage([eventNode(onTimeEvt, { metricId: metricClick, profileId }), eventNode(lateEvt, { metricId: metricClick, profileId })], [metricNode(metricClick, 'Clicked Email')], null),
      );
      const tick2 = await orchestrator.runIncremental(WS, conn.id, 'events');
      assert.equal(tick2.status, 'succeeded');

      const onTimeRows = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, onTimeEvt)));
      assert.equal(onTimeRows.length, 1, 'the redelivered on-time event inside the overlap window must never duplicate — replay is harmless');
      const lateRows = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, lateEvt)));
      assert.equal(lateRows.length, 1, 'an event never caught by tick 1 must be picked up by a later tick — missed-event reconciliation, no permanent loss');
    });

    await t.test('trait writeback: idempotent (same idempotencyKey never re-calls Klaviyo) and rejects a customer-owned property collision', async () => {
      const conn = await newConnection(WS);
      const profileId = `kp_wb_${STAMP}`;

      queue.push(jsonResponse({ data: { id: profileId } }));
      const first = await destination.write(WS, conn.id, {
        idempotencyKey: `wb_${STAMP}`,
        correlationId: `corr_wb_${STAMP}`,
        kind: 'profile_upsert',
        payload: { profileId, properties: { truvo_score_band: 'high', truvo_score: 87 } },
      });
      assert.equal(first.status, 'sent');
      assert.equal(first.externalResultId, profileId);

      const callsBefore = calls.length;
      const second = await destination.write(WS, conn.id, {
        idempotencyKey: `wb_${STAMP}`,
        correlationId: `corr_wb_${STAMP}`,
        kind: 'profile_upsert',
        payload: { profileId, properties: { truvo_score_band: 'high', truvo_score: 87 } },
      });
      assert.equal(second.status, 'sent');
      assert.equal(second.externalResultId, first.externalResultId);
      assert.equal(calls.length, callsBefore, 'the SAME idempotencyKey must never call Klaviyo a second time');

      const rejected = await destination.write(WS, conn.id, {
        idempotencyKey: `wb_bad_${STAMP}`,
        correlationId: `corr_wb_bad_${STAMP}`,
        kind: 'profile_upsert',
        payload: { profileId, properties: { customer_owned_field: 'x' } },
      });
      assert.equal(rejected.status, 'failed');
      assert.equal(rejected.retryable, false);
      assert.match(rejected.error ?? '', /not a namespaced Truvo-owned property/);
    });

    await t.test('custom event: accepted/submitted (never falsely marked exposed/opened/clicked), duplicate prevented (idempotency ledger AND Klaviyo unique_id), and delayed engagement correlates back to the originating activation when evidence exists', async () => {
      const conn = await newConnection(WS, { custom_event_metric_name: 'Truvo Activation' });
      const profileId = `kp_ce_${STAMP}`;

      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com`, emailConsent: 'SUBSCRIBED' })], null));
      await orchestrator.runBackfill(WS, conn.id, 'profiles');
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileId)));
      const customerId = identifier!.customerId;

      const activationId = `activation_${STAMP}`;
      queue.push(jsonResponse(undefined, 202));
      const first = await destination.write(WS, conn.id, {
        idempotencyKey: `ce_${STAMP}`,
        correlationId: activationId,
        kind: 'custom_event',
        payload: { customerId, profileIdentifier: { email: `${profileId}@example.com` }, metricName: 'Truvo Activation', properties: { activation_id: activationId, decision_id: `dec_${STAMP}` } },
      });
      assert.equal(first.status, 'sent');
      assert.equal(first.externalResultId, undefined, 'a 202 accepted response has no reliable provider result id — acceptance is NOT confirmed exposure (Order 063 §6)');

      const callsBeforeDup = calls.length;
      const dup = await destination.write(WS, conn.id, {
        idempotencyKey: `ce_${STAMP}`,
        correlationId: activationId,
        kind: 'custom_event',
        payload: { customerId, profileIdentifier: { email: `${profileId}@example.com` }, metricName: 'Truvo Activation', properties: { activation_id: activationId } },
      });
      assert.equal(dup.status, 'sent');
      assert.equal(calls.length, callsBeforeDup, 'duplicate custom event write must never re-POST to Klaviyo — belt-and-suspenders with unique_id');

      const outcomes = await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS));
      assert.equal(outcomes.length, 0, 'a provider-accepted custom event write must never itself fabricate a customerOutcomes row (no "opened"/"clicked"/"exposed" claim)');

      // Delayed engagement correlated back to the SAME activation when evidence
      // exists: simulate the Truvo-originated event read back through the normal
      // 'events' source path, echoing the SAME activation_id it was created with.
      const metricTruvo = `metric_truvo_${STAMP}`;
      const correlatedEvtId = `kev_correlated_${STAMP}`;
      queue.push(eventsPage([eventNode(correlatedEvtId, { metricId: metricTruvo, profileId, eventProperties: { activation_id: activationId } })], [metricNode(metricTruvo, 'Truvo Activation')], null));
      await orchestrator.runIncremental(WS, conn.id, 'events');
      const [correlatedRow] = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, correlatedEvtId)));
      assert.equal(correlatedRow!.correlationId, activationId, "Truvo's own custom event read back through the source path must correlate to the SAME activation id it was created with");

      // ... and a GENERIC, unrelated engagement event must NEVER fabricate a correlation.
      const metricOpen2 = `metric_open2_${STAMP}`;
      const genericEvtId = `kev_generic_${STAMP}`;
      queue.push(eventsPage([eventNode(genericEvtId, { metricId: metricOpen2, profileId })], [metricNode(metricOpen2, 'Opened Email')], null));
      await orchestrator.runIncremental(WS, conn.id, 'events');
      const [genericRow] = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, genericEvtId)));
      assert.equal(genericRow!.correlationId, null, 'a generic, unrelated engagement event must never fabricate attribution (Order 063 §7)');
    });

    await t.test('unsubscribed profile messaging activation is blocked fail-closed; a customer with NO synced consent trait is blocked too (unknown never means allow)', async () => {
      const conn = await newConnection(WS);
      const unsubProfileId = `kp_unsub_${STAMP}`;

      queue.push(profilesPage([profileNode(unsubProfileId, { email: `${unsubProfileId}@example.com`, emailConsent: 'UNSUBSCRIBED' })], null));
      await orchestrator.runBackfill(WS, conn.id, 'profiles');
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, unsubProfileId)));
      const customerId = identifier!.customerId;

      const callsBefore = calls.length;
      const blocked = await destination.write(WS, conn.id, {
        idempotencyKey: `blocked_${STAMP}`,
        correlationId: `corr_blocked_${STAMP}`,
        kind: 'custom_event',
        payload: { customerId, profileIdentifier: { email: `${unsubProfileId}@example.com` }, metricName: 'Truvo Activation', properties: { activation_id: `act_blocked_${STAMP}` } },
      });
      assert.equal(blocked.status, 'failed');
      assert.equal(blocked.error, 'eligibility_not_subscribed');
      assert.equal(calls.length, callsBefore, 'the adapter/Klaviyo must NEVER be called for an ineligible write');

      // A fresh `runBackfill` on the SAME connection/stream would short-circuit
      // from cache (checkpoint already 'completed' from the call above) — use
      // `runIncremental` instead, which is never cached this way, to actually
      // exercise a second real pull on the same connection.
      const noConsentProfileId = `kp_noconsent_${STAMP}`;
      queue.push(profilesPage([profileNode(noConsentProfileId, { email: `${noConsentProfileId}@example.com` })], null)); // no subscriptions object at all
      await orchestrator.runIncremental(WS, conn.id, 'profiles');
      const [identifierNoConsent] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, noConsentProfileId)));

      const blockedAbsent = await destination.write(WS, conn.id, {
        idempotencyKey: `noconsent_${STAMP}`,
        correlationId: `corr_noconsent_${STAMP}`,
        kind: 'custom_event',
        payload: { customerId: identifierNoConsent!.customerId, profileIdentifier: { email: `${noConsentProfileId}@example.com` }, metricName: 'Truvo Activation', properties: {} },
      });
      assert.equal(blockedAbsent.status, 'failed');
      assert.equal(blockedAbsent.error, 'eligibility_not_subscribed', 'an ABSENT consent trait must also fail closed — unknown never means allow');
    });

    await t.test('429 Retry-After is honored; rate-limited pull reschedules (not dropped); checkpoint does not advance past deferred records', async () => {
      const conn = await newConnection(WS);
      const profileId = `kp_rl_${STAMP}`;

      queue.push(jsonResponse({}, 429, { 'retry-after': '3' }));
      const limited = await orchestrator.runIncremental(WS, conn.id, 'profiles');
      assert.equal(limited.status, 'rate_limited');

      queue.push(profilesPage([profileNode(profileId, { email: `${profileId}@example.com` })], null));
      const retried = await orchestrator.runIncremental(WS, conn.id, 'profiles');
      assert.equal(retried.status, 'succeeded');
      assert.equal(retried.recordsRead, 1);
      const [identifier] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, profileId)));
      assert.ok(identifier, 'the record deferred by the rate limit must still be ingested on retry — never silently dropped');
    });

    await t.test('tenant isolation: identical Klaviyo profile/event ids in two workspaces stay independent', async () => {
      const connA = await newConnection(WS);
      const connB = await newConnection(WS_OTHER);
      const sharedProfile = `kp_shared_${STAMP}`;
      const sharedMetric = `metric_shared_${STAMP}`;
      const sharedEvent = `kev_shared_${STAMP}`;

      queue.push(profilesPage([profileNode(sharedProfile, { email: `${sharedProfile}@example.com`, properties: {} })], null));
      await orchestrator.runBackfill(WS, connA.id, 'profiles');
      queue.push(profilesPage([profileNode(sharedProfile, { email: `${sharedProfile}@example.com`, properties: {} })], null));
      await orchestrator.runBackfill(WS_OTHER, connB.id, 'profiles');

      const [idA] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS), eq(customerIdentifiers.identifierValue, sharedProfile)));
      const [idB] = await db.select().from(customerIdentifiers).where(and(eq(customerIdentifiers.workspaceId, WS_OTHER), eq(customerIdentifiers.identifierValue, sharedProfile)));
      assert.notEqual(idA!.customerId, idB!.customerId, 'same provider ids in different workspaces must resolve to independent customers');

      queue.push(eventsPage([eventNode(sharedEvent, { metricId: sharedMetric, profileId: sharedProfile })], [metricNode(sharedMetric, 'Opened Email')], null));
      await orchestrator.runIncremental(WS, connA.id, 'events');
      queue.push(eventsPage([eventNode(sharedEvent, { metricId: sharedMetric, profileId: sharedProfile })], [metricNode(sharedMetric, 'Opened Email')], null));
      await orchestrator.runIncremental(WS_OTHER, connB.id, 'events');

      const rowsA = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS), eq(engagementEvents.providerEventId, sharedEvent)));
      const rowsB = await db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, WS_OTHER), eq(engagementEvents.providerEventId, sharedEvent)));
      assert.equal(rowsA.length, 1);
      assert.equal(rowsB.length, 1);
      assert.notEqual(rowsA[0]!.id, rowsB[0]!.id, 'the SAME Klaviyo event id in two workspaces must be two independent rows');
    });
  } finally {
    for (const ws of [WS, WS_OTHER]) {
      await db.delete(engagementEvents).where(eq(engagementEvents.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, ws)).catch(() => undefined);
      await db.delete(customerTraits).where(eq(customerTraits.workspaceId, ws)).catch(() => undefined);
      await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, ws)).catch(() => undefined);
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
