import { createHmac } from 'node:crypto';
import type { ConnectorTestDriver } from '../../testing/fake-provider.adapter';
import type { NormalizedRecord, RawWebhookRequest } from '../../contracts';
import type { StripeFetch } from './stripe.api-client';

/**
 * Order 062 (Stripe context connector, closure 02) — a deterministic Stripe test
 * double implementing the SAME `ConnectorTestDriver` shape the fake provider and
 * `hubspot.test-driver.ts` do, so the shared `connector-contract-kit.ts` proofs
 * run against the REAL `createStripeAdapter()` unchanged (no Stripe-only copy of
 * the assertions). No live Stripe credentials/network — every response is
 * scripted here. Stripe is SOURCE-ONLY (see `stripe.constants.ts`'s
 * `DEFINITION.capabilities` — no `outbound_profile`/`outbound_event`), so
 * `forceNextWrite`/`writeCallCount`/`destinationWritePayload` exist only to
 * satisfy `ConnectorTestDriver`'s shape — the contract kit never actually calls
 * them for Stripe (`stripe.contract-kit.test.ts` never runs
 * `proveDestinationIdempotencyAndCorrelation`).
 */

export type StripePullBehavior = 'success' | 'transient_error' | 'permanent_error' | 'rate_limited';

export interface StripeDriverState {
  /** Any GET (backfill/incremental) call is served from this single queue, shifted
   * in call order — mirrors `hubspot.test-driver.ts`'s `pullQueue`. The contract
   * kit's generic proofs use arbitrary stream names that all fall through Stripe's
   * own `streamPath()`/`mapStream()` default branch (`/refunds` →
   * `mapStripeAdjustment`), so one generic queue is enough — Stripe-specific
   * per-stream fixtures live in `stripe.adapter.contract.test.ts` instead. */
  pullQueue: Response[];
  nextPullBehavior: StripePullBehavior;
  pullCallCount: number;
  nextWriteBehavior: 'success' | 'transient_error' | 'permanent_error';
  writeCallCount: number;
  validAccountId: string;
  webhookSecret: string;
  pageSize: number;
}

export function createStripeDriverState(overrides: Partial<StripeDriverState> = {}): StripeDriverState {
  return {
    pullQueue: [],
    nextPullBehavior: 'success',
    pullCallCount: 0,
    nextWriteBehavior: 'success',
    writeCallCount: 0,
    validAccountId: 'acct_contract_kit_valid',
    webhookSecret: 'contract_kit_stripe_webhook_secret',
    pageSize: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? headers[key] ?? null },
    json: async () => body,
  } as unknown as Response;
}

export function createStripeFetch(state: StripeDriverState): StripeFetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;

    // `testConnection` calls GET /account with the connected account id in the
    // `Stripe-Account` header — the ONLY way `StripeApiClient` identifies which
    // account a request is scoped to (see `stripe.api-client.ts`).
    if (url.includes('/account')) {
      if (headers['Stripe-Account'] !== state.validAccountId) return jsonResponse({}, 401);
      return jsonResponse({ id: state.validAccountId });
    }

    // Every other call is a backfill/incremental pull (customers/subscriptions/
    // invoices/payment_intents/refunds — see `stripe.adapter.ts#streamPath`).
    state.pullCallCount += 1;
    const behavior = state.nextPullBehavior;
    state.nextPullBehavior = 'success'; // consumed — next call defaults back to success
    if (behavior === 'transient_error') return jsonResponse({}, 500);
    if (behavior === 'permanent_error') return jsonResponse({}, 401);
    if (behavior === 'rate_limited') return jsonResponse({}, 429, { 'retry-after': '0' });
    return state.pullQueue.shift() ?? jsonResponse({ data: [], has_more: false });
  }) as StripeFetch;
}

const FAR_FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

export function createStripeDriver(state: StripeDriverState): ConnectorTestDriver {
  return {
    forceNextPull: (behavior) => {
      state.nextPullBehavior = behavior as StripePullBehavior;
    },
    forceNextWrite: (behavior) => {
      state.nextWriteBehavior = behavior;
    },
    seedCatalog: (records: NormalizedRecord[]) => {
      state.pullQueue = [];
      for (let i = 0; i < records.length; i += state.pageSize) {
        const chunk = records.slice(i, i + state.pageSize);
        const hasNext = i + state.pageSize < records.length;
        // Provider-shaped fake "refund"/adjustment objects — the arbitrary stream
        // names the contract kit uses all fall through to `mapStripeAdjustment`
        // (see `createStripeFetch`'s comment above). `customer` is always set so
        // `mapStripeAdjustment` resolves a real identifier (proven separately by
        // the "canonical mapping wrote through Identity Graph" check).
        const data = chunk.map((r, idx) => {
          const id = r.identifiers[0]?.identifierValue ?? `stripe_ck_${i}_${idx}`;
          return { id, customer: id, charge: null, payment_intent: null, invoice: null, amount: 1000, currency: 'usd', status: 'succeeded', created: Math.floor(Date.now() / 1000) };
        });
        state.pullQueue.push(jsonResponse({ data, has_more: hasNext }));
      }
    },
    validCredentials: () => ({ connected_account_id: state.validAccountId, webhook_secret: state.webhookSecret, livemode: false }),
    invalidCredentials: () => ({ connected_account_id: 'acct_contract_kit_wrong', webhook_secret: state.webhookSecret, livemode: false }),
    webhookRequest: (customerRef, opts = {}): RawWebhookRequest => {
      const eventId = opts.deliveryId ?? `evt_${customerRef}_${Date.now()}`;
      const body = {
        id: eventId,
        type: 'customer.subscription.updated',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: `sub_${customerRef}`, customer: customerRef, status: 'active', items: { data: [] }, created: Math.floor(Date.now() / 1000) } },
      };
      const raw = Buffer.from(JSON.stringify(body));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature =
        opts.valid === false ? 'not_a_real_signature' : createHmac('sha256', state.webhookSecret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
      return {
        headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
        body,
        rawBody: raw,
        deliveryId: opts.deliveryId,
      };
    },
    pullCallCount: () => state.pullCallCount,
    writeCallCount: () => state.writeCallCount,
    pageSize: () => state.pageSize,
    // Stripe has no destination — never invoked by the contract kit for this
    // provider; kept only to satisfy `ConnectorTestDriver`'s shape.
    destinationWritePayload: () => ({}),
  };
}
