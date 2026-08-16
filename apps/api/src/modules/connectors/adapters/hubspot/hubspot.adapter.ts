import { structuredLog } from '@truvo/observability';
import { verifyHubspot } from '../../../webhooks/crypto/signature';
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
  RawWebhookRequest,
  SourceAdapter,
  SourcePullResult,
  SyncCheckpoint,
} from '../../contracts';
import {
  HUBSPOT_API_VERSION,
  HUBSPOT_DEFAULT_PAGE_SIZE,
  HUBSPOT_OAUTH_AUTHORIZE_URL,
  HUBSPOT_OAUTH_TOKEN_URL,
  HUBSPOT_PROVIDER,
  HUBSPOT_SCOPES,
  HUBSPOT_WEBHOOK_SUBSCRIPTION_TYPES,
  HUBSPOT_WRITEBACK_PROPERTIES,
  type HubspotWritebackProperty,
} from './hubspot.constants';
import { HubspotApiClient, type HubspotCredentials, type HubspotFetch } from './hubspot.api-client';
import {
  mapCompanyPropertyChangeWebhook,
  mapContactPropertyChangeWebhook,
  mapDealPropertyChangeWebhook,
  mapDeletionWebhook,
  mapHubspotCompany,
  mapHubspotContact,
  mapHubspotDeal,
  type ConfiguredProperties,
  type HubspotObjectNode,
} from './hubspot.mapper';

/**
 * Order 061 §1/§2/§3/§6/§7/§8 — the real HubSpot `SourceAdapter` +
 * `DestinationAdapter` (bidirectional). Radar/ML logic is intentionally absent —
 * this file only reads/writes HubSpot and emits/consumes `NormalizedRecord`s
 * through the SAME contracts the Shopify adapter (Order 060) and the fake
 * provider (Order 050) already prove.
 */

export interface HubspotObjectSelection {
  contacts?: { enabled: boolean; properties: string[] };
  companies?: { enabled: boolean; properties: string[] };
  deals?: { enabled: boolean; properties: string[] };
  writeback?: { enabled: boolean };
}

function objectSelection(connection: ConnectorConnection): HubspotObjectSelection {
  const raw = connection.config.object_selection;
  return raw && typeof raw === 'object' ? (raw as HubspotObjectSelection) : { contacts: { enabled: true, properties: [] } };
}

function credentialsOf(credentials: Record<string, unknown>): HubspotCredentials {
  return {
    access_token: (credentials.access_token as string | undefined) ?? '',
    refresh_token: (credentials.refresh_token as string | undefined) ?? '',
    expires_at: (credentials.expires_at as string | undefined) ?? new Date(0).toISOString(),
    portal_id: credentials.portal_id as string | undefined,
  };
}

function requiredScopes(selection: HubspotObjectSelection): string[] {
  const scopes: string[] = [HUBSPOT_SCOPES.contactsRead];
  if (selection.companies?.enabled) scopes.push(HUBSPOT_SCOPES.companiesRead);
  if (selection.deals?.enabled) scopes.push(HUBSPOT_SCOPES.dealsRead);
  if (selection.writeback?.enabled) {
    scopes.push(HUBSPOT_SCOPES.contactsWrite);
    if (selection.deals?.enabled) scopes.push(HUBSPOT_SCOPES.dealsWrite);
  }
  return scopes;
}

const DEFINITION: ConnectorDefinition = {
  provider: HUBSPOT_PROVIDER,
  displayName: 'HubSpot',
  role: 'bidirectional',
  capabilities: ['webhook_ingest', 'initial_backfill', 'incremental_pull', 'outbound_profile'],
  credentialKind: 'oauth',
  incrementalStreams: ['contacts', 'companies', 'deals'],
};

interface HubspotSearchResponse {
  results: HubspotObjectNode[];
  paging?: { next?: { after: string } };
}

async function testConnection(connection: ConnectorConnection, credentials: Record<string, unknown>, fetchImpl: HubspotFetch): Promise<ConnectionTestResult> {
  const creds = credentialsOf(credentials);
  if (!creds.access_token || !creds.refresh_token) {
    return { ok: false, credentialStatus: 'invalid', checks: { access_token: !!creds.access_token, refresh_token: !!creds.refresh_token }, message: 'missing access_token or refresh_token' };
  }

  const client = new HubspotApiClient(creds, fetchImpl);
  try {
    const granted = new Set(await client.getGrantedScopes());
    const selection = objectSelection(connection);
    const needed = requiredScopes(selection);
    const checks = Object.fromEntries(needed.map((scope) => [scope, granted.has(scope)]));
    const missing = needed.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return { ok: false, credentialStatus: 'invalid', checks, message: `missing scopes: ${missing.join(', ')}` };
    }
    return { ok: true, credentialStatus: 'valid', checks, message: 'ok' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { ok: false, credentialStatus: 'invalid', checks: {}, message: (err as Error).message, authFailure: true };
    }
    throw err;
  }
}

function objectPath(objectType: 'contacts' | 'companies' | 'deals', suffix: string): string {
  return `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}${suffix}`;
}

/** Cursor-paginated search across ONE configured object type, `hs_lastmodifieddate`
 * filtered for incremental pulls (reconciliation — Order 061 §7). Standard search
 * API pagination, not the Bulk/async pattern — same scope decision Order 060 made
 * for Shopify, sufficient at this volume; documented, not a defect. */
async function pullObjectType(
  client: HubspotApiClient,
  objectType: 'contacts' | 'companies' | 'deals',
  properties: string[],
  associations: string[],
  cursor: string | null,
  sinceIso: string | undefined,
  pageSize: number,
): Promise<{ nodes: HubspotObjectNode[]; nextCursor: string | null; hasMore: boolean }> {
  const body: Record<string, unknown> = {
    limit: pageSize,
    properties: [...new Set(['hs_lastmodifieddate', 'hs_createdate', ...properties])],
    ...(associations.length > 0 ? { associations } : {}),
    ...(cursor ? { after: cursor } : {}),
    ...(sinceIso
      ? { filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(Date.parse(sinceIso)) }] }] }
      : {}),
  };
  const response = await client.post<HubspotSearchResponse>(objectPath(objectType, '/search'), body);
  return { nodes: response.results, nextCursor: response.paging?.next?.after ?? null, hasMore: !!response.paging?.next?.after };
}

async function pull(connection: ConnectorConnection, credentials: Record<string, unknown>, checkpoint: SyncCheckpoint, fetchImpl: HubspotFetch, incremental: boolean, pageSize: number): Promise<SourcePullResult> {
  const client = new HubspotApiClient(credentialsOf(credentials), fetchImpl);
  const selection = objectSelection(connection);

  // `streamKey` selects which object type this checkpoint/page walk is for — the
  // orchestrator already supports multiple named streams per connection
  // (Order 050); one stream per HubSpot object type keeps each type's pagination
  // independent, exactly like a future Bulk-per-object design would need anyway.
  const objectType = (checkpoint.streamKey === 'companies' ? 'companies' : checkpoint.streamKey === 'deals' ? 'deals' : 'contacts') as 'contacts' | 'companies' | 'deals';
  const enabled = objectType === 'contacts' ? true : objectType === 'companies' ? !!selection.companies?.enabled : !!selection.deals?.enabled;
  if (!enabled) return { records: [], nextCursor: checkpoint.cursor, hasMore: false };

  const properties = objectType === 'contacts' ? (selection.contacts?.properties ?? []) : objectType === 'companies' ? (selection.companies?.properties ?? []) : (selection.deals?.properties ?? []);
  const associations = objectType === 'contacts' ? ['companies'] : objectType === 'companies' ? ['contacts'] : ['contacts', 'companies'];
  const after = checkpoint.status === 'running' ? checkpoint.cursor : null;
  const sinceIso = incremental && !after ? (checkpoint.cursor ?? undefined) : undefined;

  const { nodes, nextCursor, hasMore } = await pullObjectType(client, objectType, properties, associations, after, sinceIso, pageSize);
  const mapper = objectType === 'contacts' ? mapHubspotContact : objectType === 'companies' ? mapHubspotCompany : mapHubspotDeal;
  // `associations` here is EXACTLY what was requested above — passed through so
  // the mapper can declare an authoritative `crmAssociationScope` (Order 061
  // association+contract closure) for reconciliation, not just "whatever was non-empty."
  const records: NormalizedRecord[] = nodes.map((n) => mapper(n, properties as ConfiguredProperties, associations));

  // Order 061 §2 — "missing/renamed custom properties must become visible mapping
  // errors, not silent semantic changes." HubSpot's search API silently omits an
  // unknown/renamed property key from EVERY result rather than erroring — the only
  // reliable signal is a configured property that never appears in ANY page. Made
  // visible via structured logging (observable/alertable), without failing an
  // otherwise-successful sync over a single stale mapping.
  if (nodes.length > 0) {
    const missing = properties.filter((p) => !nodes.some((n) => p in n.properties));
    if (missing.length > 0) {
      structuredLog('warn', 'hubspot_configured_property_missing', { workspaceId: connection.workspaceId, connectionId: connection.id, objectType, properties: missing });
    }
  }

  // Incremental (reconciliation) high-water mark: once caught up, advance the
  // cursor to "now" so the NEXT scheduled tick only asks for what changed since —
  // never re-walks the whole object type on every tick.
  const finalCursor = !hasMore && incremental ? new Date().toISOString() : nextCursor;
  return { records, nextCursor: finalCursor, hasMore };
}

interface HubspotWebhookEvent {
  eventId?: string | number;
  subscriptionType?: string;
  portalId?: number;
  occurredAt?: number;
  objectId?: string | number;
  propertyName?: string;
  propertyValue?: string | null;
  changeSource?: string;
}

function dispatchEvent(event: HubspotWebhookEvent, selection: HubspotObjectSelection): NormalizedRecord | null {
  const type = event.subscriptionType ?? '';
  const objectId = String(event.objectId ?? '');
  const occurredAtMs = event.occurredAt ?? Date.now();
  if (!objectId) return null;

  if (type === 'contact.creation' || type === 'contact.propertyChange') {
    return mapContactPropertyChangeWebhook(objectId, event.propertyName ?? '', event.propertyValue ?? null, occurredAtMs, (selection.contacts?.properties ?? []) as ConfiguredProperties);
  }
  if (type === 'contact.deletion') return mapDeletionWebhook('contact', objectId, 'deleted', occurredAtMs);
  if (type === 'contact.restore') return mapDeletionWebhook('contact', objectId, 'restored', occurredAtMs);
  if (type === 'contact.privacyDeletion' || type === 'contact.privacydeletion') return mapDeletionWebhook('contact', objectId, 'privacy_deleted', occurredAtMs);

  if (!selection.companies?.enabled && type.startsWith('company.')) return null;
  if (type === 'company.creation' || type === 'company.propertyChange') {
    return mapCompanyPropertyChangeWebhook(objectId, event.propertyName ?? '', event.propertyValue ?? null, occurredAtMs, (selection.companies?.properties ?? []) as ConfiguredProperties);
  }
  if (type === 'company.deletion') return mapDeletionWebhook('company', objectId, 'deleted', occurredAtMs);
  if (type === 'company.restore') return mapDeletionWebhook('company', objectId, 'restored', occurredAtMs);

  if (!selection.deals?.enabled && type.startsWith('deal.')) return null;
  if (type === 'deal.creation' || type === 'deal.propertyChange') {
    return mapDealPropertyChangeWebhook(objectId, event.propertyName ?? '', event.propertyValue ?? null, occurredAtMs, (selection.deals?.properties ?? []) as ConfiguredProperties);
  }
  if (type === 'deal.deletion') return mapDeletionWebhook('deal', objectId, 'deleted', occurredAtMs);
  if (type === 'deal.restore') return mapDeletionWebhook('deal', objectId, 'restored', occurredAtMs);

  return null;
}

/** `pageSize` is a TESTABILITY knob only (defaults to the real
 * `HUBSPOT_DEFAULT_PAGE_SIZE`) — lets contract-kit/integration tests exercise
 * multi-page checkpoint resume with small, fast fixtures instead of needing
 * hundreds of synthetic records to see a second real HubSpot page. */
export function createHubspotAdapter(fetchImpl: HubspotFetch = fetch, pageSize: number = HUBSPOT_DEFAULT_PAGE_SIZE): SourceAdapter & DestinationAdapter {
  return {
    definition: DEFINITION,
    testConnection: (connection, credentials) => testConnection(connection, credentials, fetchImpl),
    initialBackfill: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, fetchImpl, false, pageSize),
    incrementalPull: (connection, credentials, checkpoint) => pull(connection, credentials, checkpoint, fetchImpl, true, pageSize),

    getOAuthAuthorizeUrl: (connection, redirectUri): OAuthAuthorizeUrlResult => {
      const selection = objectSelection(connection);
      const scopes = requiredScopes(selection);
      const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
      const url = `${HUBSPOT_OAUTH_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes.join(' '))}`;
      return { url };
    },
    exchangeOAuthCode: async (_connection, input: OAuthExchangeInput): Promise<OAuthExchangeResult> => {
      const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
      const clientSecret = process.env.HUBSPOT_CLIENT_SECRET ?? '';
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, redirect_uri: input.redirectUri, code: input.code });
      const response = await fetchImpl(HUBSPOT_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      if (!response.ok) {
        throw Object.assign(new Error(`hubspot oauth code exchange failed (${response.status})`), { status: response.status });
      }
      const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
      const credentials: HubspotCredentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      };
      return { credentials: credentials as unknown as Record<string, unknown> };
    },

    verifyWebhook: (_connection, credentials, request: RawWebhookRequest) => {
      const secret = (credentials.client_secret as string | undefined) ?? process.env.HUBSPOT_CLIENT_SECRET ?? '';
      const raw = request.rawBody ?? Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? []));
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
      return verifyHubspot({ raw, headers, query: {}, secret, url: request.url, method: request.method });
    },

    // Order 061 §6 — THE FIX: process EVERY event in the batch, isolating
    // per-event failures (one malformed event never discards the rest). The
    // legacy M4 normalizer (`webhooks/normalizers/hubspot.ts`) only reads the
    // FIRST event — that path is untouched (still serves the OLD pipeline
    // unchanged, per "existing HubSpot inbound/outbound behavior remains
    // compatible") — this NEW Connector Framework path is the corrected one.
    normalizeWebhook: (connection, request: RawWebhookRequest): NormalizedRecord[] | null => {
      const body = request.body;
      const events: HubspotWebhookEvent[] = Array.isArray(body) ? (body as HubspotWebhookEvent[]) : [];
      if (events.length === 0) return null;

      const selection = objectSelection(connection);
      const records: NormalizedRecord[] = [];
      for (const event of events) {
        try {
          if (event.subscriptionType && !(HUBSPOT_WEBHOOK_SUBSCRIPTION_TYPES as readonly string[]).includes(event.subscriptionType) && event.subscriptionType !== 'contact.privacyDeletion') continue;
          const record = dispatchEvent(event, selection);
          if (record) records.push(record);
        } catch {
          // one malformed event is isolated — never discards the rest of the batch.
          continue;
        }
      }
      return records.length > 0 ? records : null;
    },

    write: async (connection, credentials, input: DestinationWriteInput): Promise<DestinationWriteResult> => {
      const property = input.payload.property as string | undefined;
      if (!property || !(HUBSPOT_WRITEBACK_PROPERTIES as readonly string[]).includes(property)) {
        return { status: 'failed', retryable: false, error: `writeback rejected: '${property}' is not a namespaced Truvo-owned property` };
      }
      const objectId = input.payload.objectId as string | undefined;
      if (!objectId) return { status: 'failed', retryable: false, error: 'writeback rejected: missing objectId' };
      const objectType = (input.payload.objectType as 'contacts' | 'deals' | undefined) ?? 'contacts';

      const client = new HubspotApiClient(credentialsOf(credentials), fetchImpl);
      try {
        await client.patch(objectPath(objectType, `/${objectId}`), { properties: { [property as HubspotWritebackProperty]: input.payload.value } });
        return { status: 'sent', externalResultId: `${objectType}:${objectId}:${property}` };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500);
        return { status: 'failed', retryable, error: (err as Error).message };
      }
    },
  };
}
