import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ConnectionTestResult,
  ConnectorConnection,
  ConnectorDefinition,
  DestinationAdapter,
  DestinationWriteInput,
  DestinationWriteResult,
  NormalizedRecord,
  OAuthAuthorizeUrlResult,
  OAuthExchangeInput,
  OAuthExchangeResult,
  SourceAdapter,
  SourcePullResult,
  SyncCheckpoint,
} from '../../contracts';
import { KlaviyoApiClient, type KlaviyoCredentials, type KlaviyoFetch } from './klaviyo.api-client';
import {
  KLAVIYO_DEFAULT_CUSTOM_EVENT_METRIC_NAME,
  KLAVIYO_DEFAULT_PAGE_SIZE,
  KLAVIYO_EVENT_OVERLAP_MS,
  KLAVIYO_INCREMENTAL_STREAMS,
  KLAVIYO_OAUTH_AUTHORIZE_URL,
  KLAVIYO_OAUTH_TOKEN_URL,
  KLAVIYO_PROVIDER,
  KLAVIYO_SCOPES,
  KLAVIYO_WRITEBACK_PROPERTIES,
} from './klaviyo.constants';
import { mapKlaviyoEvent, mapKlaviyoProfile, type ConfiguredProperties, type KlaviyoEventNode, type KlaviyoMetricNode, type KlaviyoProfileNode } from './klaviyo.mapper';

/**
 * Order 063 §1–§7 — the real Klaviyo `SourceAdapter` + `DestinationAdapter`
 * (bidirectional, mirroring the HubSpot precedent). Radar/propensity logic is
 * intentionally absent — this file only reads/writes Klaviyo and emits/consumes
 * `NormalizedRecord`s through the SAME contracts every other adapter proves
 * against the shared `connector-contract-kit.ts`.
 *
 * Deliberately NO `webhook_ingest` capability: Klaviyo has no general-purpose
 * developer webhooks API comparable to Stripe/HubSpot/Shopify's, and Order 063's
 * own required-runtime-proof list never mentions webhook signature verification
 * for Klaviyo — only polling/backfill/incremental. `verifyWebhook`/
 * `normalizeWebhook` are therefore left unimplemented (optional on
 * `SourceAdapter`), not stubbed out.
 */

export interface KlaviyoConfig {
  profile_properties?: string[];
  writeback_enabled?: boolean;
  custom_event_enabled?: boolean;
  custom_event_metric_name?: string;
}

function configOf(connection: ConnectorConnection): Required<KlaviyoConfig> {
  const raw = (connection.config ?? {}) as Record<string, unknown>;
  return {
    profile_properties: Array.isArray(raw.profile_properties) ? (raw.profile_properties as string[]) : [],
    writeback_enabled: raw.writeback_enabled === true,
    custom_event_enabled: raw.custom_event_enabled === true,
    custom_event_metric_name: typeof raw.custom_event_metric_name === 'string' && raw.custom_event_metric_name ? raw.custom_event_metric_name : KLAVIYO_DEFAULT_CUSTOM_EVENT_METRIC_NAME,
  };
}

function credentialsOf(credentials: Record<string, unknown>): KlaviyoCredentials {
  return {
    access_token: String(credentials.access_token ?? ''),
    refresh_token: credentials.refresh_token as string | undefined,
    expires_at: credentials.expires_at as string | undefined,
    klaviyo_account_id: credentials.klaviyo_account_id as string | undefined,
  };
}

/** Order 063 §1 — "request least-privilege scopes only for enabled
 * capabilities." `accounts:read` is mandatory on every grant; the rest follow
 * the workspace's own configuration, mirroring `hubspot.adapter.ts`'s
 * `requiredScopes(selection)`. */
function requiredScopes(config: Required<KlaviyoConfig>): string[] {
  const scopes: string[] = [KLAVIYO_SCOPES.accountsRead, KLAVIYO_SCOPES.profilesRead, KLAVIYO_SCOPES.eventsRead];
  if (config.writeback_enabled) scopes.push(KLAVIYO_SCOPES.profilesWrite);
  if (config.custom_event_enabled) scopes.push(KLAVIYO_SCOPES.eventsWrite);
  return scopes;
}

const DEFINITION: ConnectorDefinition = {
  provider: KLAVIYO_PROVIDER,
  displayName: 'Klaviyo',
  role: 'bidirectional',
  capabilities: ['initial_backfill', 'incremental_pull', 'outbound_profile', 'outbound_event'],
  credentialKind: 'oauth',
  incrementalStreams: KLAVIYO_INCREMENTAL_STREAMS,
  // Order 063 §4 — "any Truvo custom event intended to trigger a messaging flow
  // must pass current provider + Truvo eligibility rules before dispatch."
  // Gates ONLY `custom_event`; `profile_upsert` (non-messaging writeback) is
  // never gated, per §4 "profile trait writeback may update non-messaging
  // metadata without implying consent."
  activationEligibility: {
    requiredForKinds: ['custom_event'],
    consentTraitNamespace: 'messaging',
    consentTraitKey: 'email_marketing_consent',
    subscribedValues: ['SUBSCRIBED'],
  },
};

/** Order 063 §1 — PKCE state, mirroring `stripe.adapter.ts`'s `stateFor()`/
 * `verifyState()` HMAC-signed, self-contained (no server-side session storage)
 * pattern. The signed payload additionally embeds the PKCE `code_verifier` —
 * Klaviyo's OAuth 2.1 flow requires it back at token-exchange time, and this
 * adapter never persists server-side session state between the authorize
 * redirect and the callback. */
function stateFor(connection: ConnectorConnection, redirectUri: string, codeVerifier: string): string {
  const secret = process.env.KLAVIYO_OAUTH_STATE_SECRET ?? '';
  if (!secret) throw new Error('KLAVIYO_OAUTH_STATE_SECRET is required for Klaviyo OAuth');
  const payload = Buffer.from(JSON.stringify({ workspaceId: connection.workspaceId, connectionId: connection.id, redirectUri, codeVerifier, exp: Date.now() + 10 * 60_000 })).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifyState(connection: ConnectorConnection, redirectUri: string, state: string | undefined): { codeVerifier: string } {
  const secret = process.env.KLAVIYO_OAUTH_STATE_SECRET ?? '';
  if (!state || !secret) throw new Error('invalid Klaviyo OAuth state');
  const [payload, received] = state.split('.');
  const expected = createHmac('sha256', secret).update(payload ?? '').digest('base64url');
  if (!payload || !received || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    throw new Error('invalid Klaviyo OAuth state');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { workspaceId: string; connectionId: string; redirectUri: string; codeVerifier: string; exp: number };
  if (decoded.workspaceId !== connection.workspaceId || decoded.connectionId !== connection.id || decoded.redirectUri !== redirectUri || decoded.exp < Date.now()) {
    throw new Error('expired Klaviyo OAuth state');
  }
  return { codeVerifier: decoded.codeVerifier };
}

async function testConnection(connection: ConnectorConnection, credentials: Record<string, unknown>, fetchImpl: KlaviyoFetch): Promise<ConnectionTestResult> {
  const creds = credentialsOf(credentials);
  if (!creds.access_token) {
    return { ok: false, credentialStatus: 'invalid', checks: { access_token: false }, message: 'missing access_token' };
  }
  // Klaviyo has no dedicated scope-introspection endpoint (unlike HubSpot's
  // `/oauth/v1/access-tokens/{token}`) — the honest, accurate check available is
  // the same simple existence-check Stripe's `testConnection` uses: a real,
  // low-privilege authenticated call (`GET /api/accounts`) that succeeds only
  // with a valid, still-authorized token.
  try {
    await new KlaviyoApiClient(creds, fetchImpl).get('/api/accounts');
    return { ok: true, credentialStatus: 'valid', checks: { account_access: true }, message: 'ok' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { ok: false, credentialStatus: 'invalid', checks: { account_access: false }, message: (err as Error).message, authFailure: true };
    }
    throw err;
  }
}

interface KlaviyoPage<TNode> {
  data: TNode[];
  included?: KlaviyoMetricNode[];
  links?: { next?: string | null };
}

async function pullProfilesPage(client: KlaviyoApiClient, checkpoint: SyncCheckpoint, pageSize: number, incremental: boolean): Promise<{ nodes: KlaviyoProfileNode[]; nextCursor: string | null; hasMore: boolean }> {
  const resuming = checkpoint.status === 'running' && !!checkpoint.cursor;
  let url: string;
  if (resuming) {
    url = checkpoint.cursor!;
  } else {
    const params = new URLSearchParams({ 'page[size]': String(pageSize), 'additional-fields[profile]': 'subscriptions' });
    if (incremental && checkpoint.cursor) {
      params.set('filter', `greater-than(updated,${checkpoint.cursor})`);
      params.set('sort', 'updated');
    }
    url = `/api/profiles?${params.toString()}`;
  }
  const page = await client.request<KlaviyoPage<KlaviyoProfileNode>>(url);
  const nextUrl = page.links?.next ?? null;
  return { nodes: page.data, nextCursor: nextUrl, hasMore: !!nextUrl };
}

async function pullEventsPage(client: KlaviyoApiClient, checkpoint: SyncCheckpoint, pageSize: number, incremental: boolean): Promise<{ nodes: KlaviyoEventNode[]; metricsById: Map<string, KlaviyoMetricNode>; nextCursor: string | null; hasMore: boolean }> {
  const resuming = checkpoint.status === 'running' && !!checkpoint.cursor;
  let url: string;
  if (resuming) {
    url = checkpoint.cursor!;
  } else {
    // include=metric resolves the metric NAME inline (Klaviyo's Get Events
    // response only embeds the metric ID by default) — avoids a separate
    // metric-resolution round trip per sync (Order 063 research note).
    const params = new URLSearchParams({ 'page[size]': String(pageSize), include: 'metric' });
    if (incremental && checkpoint.cursor) {
      params.set('filter', `greater-than(datetime,${checkpoint.cursor})`);
      params.set('sort', 'datetime');
    }
    url = `/api/events?${params.toString()}`;
  }
  const page = await client.request<KlaviyoPage<KlaviyoEventNode>>(url);
  const metricsById = new Map((page.included ?? []).filter((r) => !r.type || r.type === 'metric').map((m) => [m.id, m]));
  const nextUrl = page.links?.next ?? null;
  return { nodes: page.data, metricsById, nextCursor: nextUrl, hasMore: !!nextUrl };
}

async function pull(connection: ConnectorConnection, credentials: Record<string, unknown>, checkpoint: SyncCheckpoint, fetchImpl: KlaviyoFetch, incremental: boolean, pageSize: number): Promise<SourcePullResult> {
  const client = new KlaviyoApiClient(credentialsOf(credentials), fetchImpl);
  const config = configOf(connection);

  if (checkpoint.streamKey === 'events') {
    const { nodes, metricsById, nextCursor, hasMore } = await pullEventsPage(client, checkpoint, pageSize, incremental);
    const records: NormalizedRecord[] = nodes.map((n) => mapKlaviyoEvent(n, metricsById, config.custom_event_metric_name));
    // Order 063 §3 — delayed-event-safe: on catch-up, back OFF by the bounded
    // overlap window rather than jumping to exactly now(). Never applied to the
    // 'profiles' stream (mutable state, safe to advance to now() on catch-up).
    const finalCursor = !hasMore && incremental ? new Date(Date.now() - KLAVIYO_EVENT_OVERLAP_MS).toISOString() : nextCursor;
    return { records, nextCursor: finalCursor, hasMore };
  }

  // Every other/arbitrary stream key defaults to 'profiles' — mirrors
  // `hubspot.adapter.ts`/`stripe.adapter.ts`'s own default-branch convention,
  // which is exactly what lets the shared contract kit's arbitrary stream names
  // exercise a real, representative pull path.
  const { nodes, nextCursor, hasMore } = await pullProfilesPage(client, checkpoint, pageSize, incremental);
  const records: NormalizedRecord[] = nodes.map((n) => mapKlaviyoProfile(n, config.profile_properties as ConfiguredProperties));
  const finalCursor = !hasMore && incremental ? new Date().toISOString() : nextCursor;
  return { records, nextCursor: finalCursor, hasMore };
}

function retryableStatus(status: unknown): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/** `pageSize` is a TESTABILITY knob only (defaults to the real
 * `KLAVIYO_DEFAULT_PAGE_SIZE`) — mirrors `createHubspotAdapter`'s second
 * parameter, letting contract-kit/integration tests exercise multi-page
 * checkpoint resume with small, fast fixtures. */
export function createKlaviyoAdapter(fetchImpl: KlaviyoFetch = fetch, pageSize: number = KLAVIYO_DEFAULT_PAGE_SIZE): SourceAdapter & DestinationAdapter {
  return {
    definition: DEFINITION,
    testConnection: (connection, credentials) => testConnection(connection, credentials, fetchImpl),
    initialBackfill: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, fetchImpl, false, pageSize),
    incrementalPull: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, fetchImpl, true, pageSize),

    getOAuthAuthorizeUrl: (connection, redirectUri): OAuthAuthorizeUrlResult => {
      const clientId = process.env.KLAVIYO_CLIENT_ID ?? '';
      if (!clientId) throw new Error('KLAVIYO_CLIENT_ID is required for Klaviyo OAuth');
      const config = configOf(connection);
      // RFC 7636 code_verifier: 43-128 chars of unreserved characters —
      // base64url of 32 random bytes yields 43 chars.
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: requiredScopes(config).join(' '),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: stateFor(connection, redirectUri, codeVerifier),
      });
      return { url: `${KLAVIYO_OAUTH_AUTHORIZE_URL}?${query.toString()}` };
    },

    exchangeOAuthCode: async (connection, input: OAuthExchangeInput): Promise<OAuthExchangeResult> => {
      const { codeVerifier } = verifyState(connection, input.redirectUri, input.state);
      const clientId = process.env.KLAVIYO_CLIENT_ID ?? '';
      const clientSecret = process.env.KLAVIYO_CLIENT_SECRET;
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
      // Confidential-client fallback — harmless to include alongside PKCE when set.
      if (clientSecret) body.set('client_secret', clientSecret);

      const response = await fetchImpl(KLAVIYO_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      if (!response.ok) throw Object.assign(new Error(`klaviyo oauth code exchange failed (${response.status})`), { status: response.status });
      const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; token_type?: string };

      const credentials: KlaviyoCredentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      };

      // Order 063 §1 (mirrors Stripe's `stripe_account_id` immutable-identity
      // pattern) — fetch the authorized account's own id for `connectionMetadata`.
      const account = await new KlaviyoApiClient(credentials, fetchImpl).get<{ data: Array<{ id: string }> }>('/api/accounts');
      const accountId = account.data?.[0]?.id;
      if (!accountId) throw new Error('Klaviyo OAuth response missing account id');

      return { credentials: credentials as unknown as Record<string, unknown>, connectionMetadata: { klaviyo_account_id: accountId } };
    },

    write: async (connection, credentials, input: DestinationWriteInput): Promise<DestinationWriteResult> => {
      const client = new KlaviyoApiClient(credentialsOf(credentials), fetchImpl);

      if (input.kind === 'profile_upsert') {
        const profileId = input.payload.profileId as string | undefined;
        const properties = input.payload.properties as Record<string, unknown> | undefined;
        if (!profileId) return { status: 'failed', retryable: false, error: 'writeback rejected: missing profileId' };
        if (!properties || Object.keys(properties).length === 0) return { status: 'failed', retryable: false, error: 'writeback rejected: empty properties' };
        const invalid = Object.keys(properties).filter((key) => !(KLAVIYO_WRITEBACK_PROPERTIES as readonly string[]).includes(key));
        if (invalid.length > 0) {
          // Order 063 §5 — "never overwrite customer-owned properties unless
          // explicitly mapped." ANY non-allowlisted key rejects the WHOLE write.
          return { status: 'failed', retryable: false, error: `writeback rejected: '${invalid.join(', ')}' is not a namespaced Truvo-owned property` };
        }
        try {
          await client.patch(`/api/profiles/${profileId}`, { data: { type: 'profile', id: profileId, attributes: { properties } } });
          return { status: 'sent', externalResultId: profileId };
        } catch (err) {
          return { status: 'failed', retryable: retryableStatus((err as { status?: number }).status), error: (err as Error).message };
        }
      }

      if (input.kind === 'custom_event') {
        const profileIdentifier = input.payload.profileIdentifier as Record<string, unknown> | undefined;
        if (!profileIdentifier || Object.keys(profileIdentifier).length === 0) {
          return { status: 'failed', retryable: false, error: 'custom event rejected: missing profileIdentifier' };
        }
        const metricName = (input.payload.metricName as string | undefined) || configOf(connection).custom_event_metric_name;
        const properties = (input.payload.properties as Record<string, unknown> | undefined) ?? {};
        try {
          await client.post('/api/events', {
            data: {
              type: 'event',
              attributes: {
                metric: { data: { type: 'metric', attributes: { name: metricName } } },
                profile: { data: { type: 'profile', attributes: profileIdentifier } },
                properties,
                // Klaviyo's OWN server-side idempotency key — belt-and-suspenders
                // on top of the framework's `connector_destination_writes` ledger
                // (Order 063 §6 "duplicate custom event prevented").
                unique_id: input.idempotencyKey,
                time: new Date().toISOString(),
              },
            },
          });
          // Order 063 §6 — a 202 means accepted/submitted, NOT confirmed exposure.
          // Klaviyo does not reliably return an event id for this endpoint —
          // `externalResultId` stays absent rather than fabricated.
          return { status: 'sent' };
        } catch (err) {
          return { status: 'failed', retryable: retryableStatus((err as { status?: number }).status), error: (err as Error).message };
        }
      }

      return { status: 'failed', retryable: false, error: `unsupported write kind '${input.kind}'` };
    },
  };
}
