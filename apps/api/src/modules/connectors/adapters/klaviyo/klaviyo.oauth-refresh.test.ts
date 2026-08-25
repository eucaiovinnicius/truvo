import assert from 'node:assert/strict';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { closeDb, connectorConnections, connectorDestinationWrites, connectorSyncCheckpoints, connectorSyncRuns, createDb, customerTraits, customers } from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { ConnectorDestinationService } from '../../connector-destination.service';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { ConnectorSyncOrchestratorService } from '../../connector-sync-orchestrator.service';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import type { KlaviyoFetch } from './klaviyo.api-client';
import { KLAVIYO_PROVIDER } from './klaviyo.constants';

process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order063_oauth_refresh_test_key';
process.env.KLAVIYO_CLIENT_ID ??= 'order063_oauth_refresh_client';
process.env.KLAVIYO_CLIENT_SECRET ??= 'order063_oauth_refresh_secret';

const WS = `test_ws_klaviyo_refresh_${Date.now()}`;
const WS_B = `${WS}_b`;
const expired = () => new Date(Date.now() - 60_000).toISOString();
const ok = (body: unknown, status = 200): Response => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response);

test('Klaviyo OAuth refresh atomically persists rotated encrypted credentials and concurrent callers reuse them', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this Order 063 runtime test');
  const db = createDb();
  const registry = new ConnectorRegistryService();
  const audit = new AuditService(db);
  const connections = new ConnectorConnectionService(db, audit, registry);
  let canonicalWrites = 0;
  const mapping = { apply: async (_workspace: string, _connection: string, _source: string, records: unknown[]) => { canonicalWrites += records.length; return { identifiersAttached: records.length, traitsWritten: 0, customersResolved: records.length }; } };
  const orchestrator = new ConnectorSyncOrchestratorService(db, connections, registry, mapping as never);
  const destination = new ConnectorDestinationService(db, connections, registry, audit);
  const refreshes: string[] = [];
  const apiTokens: string[] = [];
  const force401 = new Set<string>();
  let profileWrites = 0;
  let eventWrites = 0;
  const fetchImpl: KlaviyoFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      refreshes.push(refreshToken);
      if (refreshToken === 'R1') return ok({ access_token: 'access_token_B_order063', refresh_token: 'refresh_token_R2_order063', expires_in: 3600 });
      if (refreshToken === 'refresh_token_R2_order063') return ok({ access_token: 'access_token_C_order063', refresh_token: 'refresh_token_R3_order063', expires_in: 3600 });
      return ok({ error: 'invalid_grant' }, 400);
    }
    const authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
    apiTokens.push(authorization);
    if (force401.has(authorization)) return ok({}, 401);
    if (url.includes('/api/profiles') && init?.method === 'PATCH') { profileWrites += 1; return ok({ data: { id: 'profile_1' } }); }
    if (url.includes('/api/events') && init?.method === 'POST') { eventWrites += 1; return ok(undefined, 202); }
    return ok({ data: [{ id: 'profile_1', attributes: { email: 'buyer@example.com', updated: new Date().toISOString() } }], links: { next: null } });
  }) as KlaviyoFetch;
  const adapter = createKlaviyoAdapter(fetchImpl);
  registry.registerSource(adapter);
  registry.registerDestination(adapter);
  try {
    const connection = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'OAuth refresh proof' });
    await connections.setCredentials(WS, connection.id, { access_token: 'A', refresh_token: 'R1', expires_at: expired(), klaviyo_account_id: 'acct_immutable' });
    await connections.applySyncOutcome(WS, connection.id, { state: 'connected' });

    const [a, b] = await Promise.all([
      connections.resolveOAuthCredentials(WS, connection.id, adapter.oauthRefresh, { observedAccessToken: 'A' }),
      connections.resolveOAuthCredentials(WS, connection.id, adapter.oauthRefresh, { observedAccessToken: 'A' }),
    ]);
    assert.deepEqual(refreshes, ['R1'], 'exactly one provider refresh may consume the old rotating token');
    assert.equal(a.credentials.access_token, 'access_token_B_order063');
    assert.equal(b.credentials.access_token, 'access_token_B_order063');
    assert.equal(a.credentials.refresh_token, 'refresh_token_R2_order063');
    const reloaded = await connections.getConnectionWithCredentials(WS, connection.id);
    assert.equal(reloaded.credentials.refresh_token, 'refresh_token_R2_order063', 'reload decrypts the persisted rotated token');
    const [raw] = await db.select().from(connectorConnections).where(and(eq(connectorConnections.workspaceId, WS), eq(connectorConnections.id, connection.id)));
    assert.ok(raw!.credentialsEncrypted && !raw!.credentialsEncrypted.includes('access_token_B_order063') && !raw!.credentialsEncrypted.includes('refresh_token_R2_order063'));
    assert.equal(JSON.stringify(await connections.get(WS, connection.id)).includes('refresh_token_R2_order063'), false, 'public connection response has no token material');

    await connections.setCredentials(WS, connection.id, { ...reloaded.credentials, expires_at: expired() });
    await connections.resolveOAuthCredentials(WS, connection.id, adapter.oauthRefresh, { observedAccessToken: 'access_token_B_order063' });
    assert.deepEqual(refreshes, ['R1', 'refresh_token_R2_order063'], 'the next refresh must use R2, never the invalidated R1');

    const source = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'source continuity' });
    await connections.setCredentials(WS, source.id, { access_token: 'A', refresh_token: 'R1', expires_at: expired() });
    await connections.applySyncOutcome(WS, source.id, { state: 'connected' });
    const sourceResult = await orchestrator.runIncremental(WS, source.id, 'profiles');
    assert.equal(sourceResult.status, 'succeeded');
    assert.ok(canonicalWrites > 0, 'successful source sync reaches canonical mapping');
    const [sourceCheckpoint] = await db.select().from(connectorSyncCheckpoints).where(and(eq(connectorSyncCheckpoints.workspaceId, WS), eq(connectorSyncCheckpoints.connectionId, source.id)));
    assert.equal(sourceCheckpoint!.status, 'completed');
    assert.ok(sourceCheckpoint!.cursor, 'checkpoint advances only after successful canonical work');
    assert.ok(apiTokens.includes('Bearer access_token_B_order063'));

    const recovery = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: '401 recovery' });
    await connections.setCredentials(WS, recovery.id, { access_token: 'A', refresh_token: 'R1', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await connections.applySyncOutcome(WS, recovery.id, { state: 'connected' });
    force401.add('Bearer A');
    assert.equal((await orchestrator.runIncremental(WS, recovery.id, 'profiles')).status, 'succeeded');
    force401.delete('Bearer A');
    assert.ok(apiTokens.includes('Bearer A') && apiTokens.includes('Bearer access_token_B_order063'), '401 recovery performs one retry with refreshed B');

    const revoked = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'revoked source' });
    await connections.setCredentials(WS, revoked.id, { access_token: 'A', refresh_token: 'R_REVOKED', expires_at: expired() });
    await connections.applySyncOutcome(WS, revoked.id, { state: 'connected' });
    const revokedResult = await orchestrator.runIncremental(WS, revoked.id, 'profiles');
    assert.equal(revokedResult.status, 'failed');
    const revokedPublic = await connections.get(WS, revoked.id);
    assert.equal(revokedPublic.lifecycleState, 'disconnected');
    assert.equal(revokedPublic.credentialStatus, 'invalid');
    const [revokedCheckpoint] = await db.select().from(connectorSyncCheckpoints).where(and(eq(connectorSyncCheckpoints.workspaceId, WS), eq(connectorSyncCheckpoints.connectionId, revoked.id)));
    assert.equal(revokedCheckpoint!.cursor, null);
    await assert.rejects(() => orchestrator.runIncremental(WS, revoked.id, 'profiles'));

    const destinationConnection = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'destination continuity' });
    await connections.setCredentials(WS, destinationConnection.id, { access_token: 'A', refresh_token: 'R1', expires_at: expired() });
    await connections.applySyncOutcome(WS, destinationConnection.id, { state: 'connected' });
    const profileResult = await destination.write(WS, destinationConnection.id, { idempotencyKey: 'profile-refresh', correlationId: 'profile-refresh', kind: 'profile_upsert', payload: { profileId: 'profile_1', properties: { truvo_score_band: 'high' } } });
    assert.equal(profileResult.status, 'sent');
    assert.equal(profileWrites, 1);
    const currentDestination = await connections.getConnectionWithCredentials(WS, destinationConnection.id);
    await connections.setCredentials(WS, destinationConnection.id, { ...currentDestination.credentials, expires_at: expired() });
    const now = new Date();
    await db.insert(customers).values({ workspaceId: WS, id: 'customer_activation', status: 'identified', sourceNamespace: 'test', firstSeenAt: now, lastSeenAt: now });
    await db.insert(customerTraits).values({ workspaceId: WS, id: 'consent_activation', customerId: 'customer_activation', traitNamespace: 'messaging', traitKey: 'email_marketing_consent', valueType: 'string', value: 'SUBSCRIBED', sourceNamespace: 'test', observedAt: now });
    const eventInput = { idempotencyKey: 'activation-refresh', correlationId: 'activation-refresh', kind: 'custom_event', payload: { customerId: 'customer_activation', profileIdentifier: { email: 'buyer@example.com' } } };
    assert.equal((await destination.write(WS, destinationConnection.id, eventInput)).status, 'sent');
    assert.equal((await destination.write(WS, destinationConnection.id, eventInput)).status, 'sent');
    assert.equal(eventWrites, 1, 'custom event idempotency prevents duplicate provider emission');
    const [ledger] = await db.select().from(connectorDestinationWrites).where(and(eq(connectorDestinationWrites.workspaceId, WS), eq(connectorDestinationWrites.connectionId, destinationConnection.id), eq(connectorDestinationWrites.idempotencyKey, 'activation-refresh')));
    assert.equal(ledger!.status, 'sent');

    const revokedDestination = await connections.create(WS, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'revoked destination' });
    await connections.setCredentials(WS, revokedDestination.id, { access_token: 'A', refresh_token: 'R_REVOKED', expires_at: expired() });
    await connections.applySyncOutcome(WS, revokedDestination.id, { state: 'connected' });
    const beforeWrites = profileWrites;
    const revokedWrite = await destination.write(WS, revokedDestination.id, { idempotencyKey: 'revoked-write', correlationId: 'revoked-write', kind: 'profile_upsert', payload: { profileId: 'profile_1', properties: { truvo_score_band: 'high' } } });
    assert.equal(revokedWrite.status, 'failed');
    assert.equal(profileWrites, beforeWrites, 'refresh failure never writes with stale credentials');
    assert.equal((await connections.get(WS, revokedDestination.id)).lifecycleState, 'disconnected');
    assert.equal((await destination.write(WS, revokedDestination.id, { idempotencyKey: 'revoked-write', correlationId: 'revoked-write', kind: 'profile_upsert', payload: { profileId: 'profile_1', properties: { truvo_score_band: 'high' } } })).status, 'failed');

    const tenantB = await connections.create(WS_B, { provider: KLAVIYO_PROVIDER, role: 'bidirectional', displayName: 'tenant B' });
    await connections.setCredentials(WS_B, tenantB.id, { access_token: 'A', refresh_token: 'R1', expires_at: expired() });
    await connections.resolveOAuthCredentials(WS_B, tenantB.id, adapter.oauthRefresh, { observedAccessToken: 'A' });
    const tenantBReloaded = await connections.getConnectionWithCredentials(WS_B, tenantB.id);
    assert.equal(tenantBReloaded.credentials.refresh_token, 'refresh_token_R2_order063');
    const tenantAStillScoped = await connections.getConnectionWithCredentials(WS, connection.id);
    assert.equal(tenantAStillScoped.credentials.refresh_token, 'refresh_token_R3_order063');
    assert.equal(JSON.stringify(await connections.get(WS, connection.id)).includes('access_token'), false, 'public responses never expose access tokens');
  } finally {
    await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorDestinationWrites).where(eq(connectorDestinationWrites.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncRuns).where(eq(connectorSyncRuns.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorSyncCheckpoints).where(eq(connectorSyncCheckpoints.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS)).catch(() => undefined);
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(customerTraits).where(eq(customerTraits.workspaceId, WS)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS)).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
