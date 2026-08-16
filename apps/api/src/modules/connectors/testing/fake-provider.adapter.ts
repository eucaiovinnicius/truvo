import type {
  ConnectionTestResult,
  ConnectorConnection,
  ConnectorDefinition,
  DestinationAdapter,
  DestinationWriteInput,
  DestinationWriteResult,
  NormalizedRecord,
  RawWebhookRequest,
  SourceAdapter,
  SourcePullResult,
} from '../contracts';

/**
 * Order 050 §"Contract test kit" — a complete fake provider proving the framework
 * itself (retry/backoff, rate-limit, checkpoint resume, webhook idempotency,
 * destination idempotency) without any real HTTP calls. A future real adapter
 * (Orders 60–63) implements the SAME `SourceAdapter`/`DestinationAdapter`
 * interfaces this fake does — nothing about the orchestrator/webhook/destination
 * services changes to support it.
 */
export const FAKE_PROVIDER = 'fake_provider';

export type FakePullBehavior = 'success' | 'transient_error' | 'permanent_error' | 'rate_limited';

export interface FakeProviderState {
  /** Records available across ALL pages, in order — the fake paginates 2 at a time. */
  catalog: NormalizedRecord[];
  /** Behavior for the NEXT pull call only; resets to 'success' after being consumed
   * once (simulates "transient failure once, then succeeds on retry"). */
  nextPullBehavior: FakePullBehavior;
  pullCallCount: number;
  /** Behavior for the NEXT destination write only. */
  nextWriteBehavior: 'success' | 'transient_error' | 'permanent_error';
  writeCallCount: number;
  /** Credential value considered valid — anything else fails testConnection. */
  validApiKey: string;
  /** HMAC-like shared secret for fake webhook signature verification. */
  webhookSecret: string;
}

export function createFakeProviderState(overrides: Partial<FakeProviderState> = {}): FakeProviderState {
  return {
    catalog: [],
    nextPullBehavior: 'success',
    pullCallCount: 0,
    nextWriteBehavior: 'success',
    writeCallCount: 0,
    validApiKey: 'fake_valid_key',
    webhookSecret: 'fake_webhook_secret',
    ...overrides,
  };
}

const DEFINITION: ConnectorDefinition = {
  provider: FAKE_PROVIDER,
  displayName: 'Fake Provider (contract test kit)',
  role: 'bidirectional',
  capabilities: ['webhook_ingest', 'initial_backfill', 'incremental_pull', 'outbound_profile', 'outbound_event'],
  credentialKind: 'api_key',
};

function pageSize() {
  return 2;
}

async function testConnection(_connection: ConnectorConnection, credentials: Record<string, unknown>, state: FakeProviderState): Promise<ConnectionTestResult> {
  const apiKey = credentials.api_key;
  if (apiKey === state.validApiKey) {
    return { ok: true, credentialStatus: 'valid', checks: { api_key: true }, message: 'ok' };
  }
  return { ok: false, credentialStatus: 'invalid', checks: { api_key: false }, message: 'invalid api_key', authFailure: true };
}

async function pull(_connection: ConnectorConnection, _credentials: Record<string, unknown>, checkpoint: { cursor: string | null }, state: FakeProviderState): Promise<SourcePullResult> {
  state.pullCallCount += 1;
  const behavior = state.nextPullBehavior;
  state.nextPullBehavior = 'success'; // consumed — next call defaults back to success

  if (behavior === 'transient_error') throw Object.assign(new Error('temporary network blip'), { code: 'ECONNRESET' });
  if (behavior === 'permanent_error') throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (behavior === 'rate_limited') throw Object.assign(new Error('too many requests'), { status: 429 });

  const offset = checkpoint.cursor ? Number(checkpoint.cursor) : 0;
  const page = state.catalog.slice(offset, offset + pageSize());
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < state.catalog.length;
  // cursor always advances to the new high-water mark; `hasMore` (not a null
  // cursor) is what tells the orchestrator whether to keep paginating now.
  return { records: page, nextCursor: String(nextOffset), hasMore };
}

export function createFakeSourceAdapter(state: FakeProviderState): SourceAdapter {
  return {
    definition: DEFINITION,
    testConnection: (connection, credentials) => testConnection(connection, credentials, state),
    initialBackfill: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, state),
    incrementalPull: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, state),
    verifyWebhook: (_connection, _credentials, request) => {
      const signature = request.headers['x-fake-signature'];
      const provided = Array.isArray(signature) ? signature[0] : signature;
      return provided === state.webhookSecret;
    },
    normalizeWebhook: (_connection, request) => {
      const body = request.body as { customer_ref?: string } | undefined;
      if (!body?.customer_ref) return null;
      const record: NormalizedRecord = {
        identifiers: [{ providerNamespace: FAKE_PROVIDER, identifierType: 'external_id', identifierValue: body.customer_ref }],
        observedAt: new Date().toISOString(),
      };
      return [record];
    },
  };
}

/** Minimal, adapter-owned failure-injection surface the reusable contract kit
 * drives — a FUTURE real adapter's own test would implement the same shape
 * against a sandbox/mock, letting `connector-contract-kit.ts`'s `proveXxx`
 * functions run unchanged against it. */
export interface ConnectorTestDriver {
  forceNextPull(behavior: FakePullBehavior): void;
  forceNextWrite(behavior: 'transient_error' | 'permanent_error'): void;
  seedCatalog(records: NormalizedRecord[]): void;
  validCredentials(): Record<string, unknown>;
  invalidCredentials(): Record<string, unknown>;
  webhookRequest(customerRef: string, opts?: { valid?: boolean; deliveryId?: string }): RawWebhookRequest;
  pullCallCount(): number;
  writeCallCount(): number;
  /** Order 061 (association contract closure) — how many records a single
   * backfill/incremental page returns. Lets `proveBackfillCheckpointResume`
   * (connector-contract-kit.ts) derive its per-page expectations generically
   * instead of hardcoding the fake provider's own page size, so a REAL adapter's
   * driver (which may choose a different — or test-overridden — page size) can
   * share the exact same proof unweakened. */
  pageSize(): number;
  /** Order 061 — a driver-appropriate payload for `ConnectorDestinationService.write()`.
   * The fake destination never validates its payload; a real destination adapter
   * (e.g. HubSpot's namespaced-property writeback) does, so the kit asks the
   * driver for a payload its OWN adapter will actually accept — the assertions in
   * `proveDestinationIdempotencyAndCorrelation` stay identical either way. */
  destinationWritePayload(): Record<string, unknown>;
}

export function createFakeDriver(state: FakeProviderState): ConnectorTestDriver {
  return {
    forceNextPull: (behavior) => {
      state.nextPullBehavior = behavior;
    },
    forceNextWrite: (behavior) => {
      state.nextWriteBehavior = behavior;
    },
    seedCatalog: (records) => {
      state.catalog = records;
    },
    validCredentials: () => ({ api_key: state.validApiKey }),
    invalidCredentials: () => ({ api_key: 'wrong_key' }),
    webhookRequest: (customerRef, opts = {}) => ({
      headers: { 'x-fake-signature': opts.valid === false ? 'wrong_signature' : state.webhookSecret },
      body: { customer_ref: customerRef },
      deliveryId: opts.deliveryId,
    }),
    pullCallCount: () => state.pullCallCount,
    writeCallCount: () => state.writeCallCount,
    pageSize: () => pageSize(),
    destinationWritePayload: () => ({ any: 'thing' }),
  };
}

export function createFakeDestinationAdapter(state: FakeProviderState): DestinationAdapter {
  return {
    definition: DEFINITION,
    testConnection: (connection, credentials) => testConnection(connection, credentials, state),
    write: async (_connection, _credentials, input: DestinationWriteInput): Promise<DestinationWriteResult> => {
      state.writeCallCount += 1;
      const behavior = state.nextWriteBehavior;
      state.nextWriteBehavior = 'success';

      if (behavior === 'transient_error') throw Object.assign(new Error('provider timeout'), { code: 'ETIMEDOUT' });
      if (behavior === 'permanent_error') throw Object.assign(new Error('invalid payload'), { status: 422 });

      // A real provider assigns its OWN id per call, independent of our idempotency
      // key — incorporating the call count (not the caller's key) keeps this fake
      // realistic: two different callers using the same idempotencyKey (e.g. two
      // different workspaces) must not collide on externalResultId either.
      return { status: 'sent', externalResultId: `fake_result_${state.writeCallCount}_${input.idempotencyKey}` };
    },
  };
}
