import assert from 'node:assert/strict';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { closeDb, connectorConnections, createDb } from '@truvo/db';
import { AuditService } from '../../../audit/audit.service';
import { ConnectorConnectionService } from '../../connector-connection.service';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import type { KlaviyoFetch } from './klaviyo.api-client';
import { KLAVIYO_PROVIDER } from './klaviyo.constants';

process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order063_oauth_refresh_test_key';
process.env.KLAVIYO_CLIENT_ID ??= 'order063_oauth_refresh_client';
process.env.KLAVIYO_CLIENT_SECRET ??= 'order063_oauth_refresh_secret';

const WS = `test_ws_klaviyo_refresh_${Date.now()}`;
const expired = () => new Date(Date.now() - 60_000).toISOString();
const ok = (body: unknown, status = 200): Response => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body } as unknown as Response);

test('Klaviyo OAuth refresh atomically persists rotated encrypted credentials and concurrent callers reuse them', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this Order 063 runtime test');
  const db = createDb();
  const registry = new ConnectorRegistryService();
  const connections = new ConnectorConnectionService(db, new AuditService(db), registry);
  const refreshes: string[] = [];
  const fetchImpl: KlaviyoFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      refreshes.push(refreshToken);
      if (refreshToken === 'R1') return ok({ access_token: 'access_token_B_order063', refresh_token: 'refresh_token_R2_order063', expires_in: 3600 });
      if (refreshToken === 'refresh_token_R2_order063') return ok({ access_token: 'access_token_C_order063', refresh_token: 'refresh_token_R3_order063', expires_in: 3600 });
      return ok({ error: 'invalid_grant' }, 400);
    }
    return ok({ data: [], links: { next: null } });
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
  } finally {
    await db.delete(connectorConnections).where(eq(connectorConnections.workspaceId, WS)).catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }
});
