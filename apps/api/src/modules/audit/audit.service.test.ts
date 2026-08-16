import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditService } from './audit.service';
import type { Database } from '../auth/database.provider';

/** Fake mínimo do driver Drizzle: só o que AuditService usa (`insert().values()`). */
function fakeDb(onInsert: (table: unknown, values: Record<string, unknown>) => void, shouldThrow = false) {
  return {
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (shouldThrow) throw new Error('boom');
        onInsert(table, values);
        return [];
      },
    }),
  } as unknown as Database;
}

test('record() persists workspace-scoped audit row with defaults', async () => {
  let captured: Record<string, unknown> | undefined;
  const db = fakeDb((_table, values) => {
    captured = values;
  });
  const svc = new AuditService(db);

  await svc.record({
    workspaceId: 'ws_1',
    category: 'membership',
    action: 'membership.role_changed',
    resourceType: 'workspace_member',
    resourceId: 'user_1',
    actorUserId: 'user_owner',
    metadata: { from_role: 'member', to_role: 'admin' },
  });

  assert.ok(captured);
  assert.equal(captured!.workspaceId, 'ws_1');
  assert.equal(captured!.category, 'membership');
  assert.equal(captured!.action, 'membership.role_changed');
  assert.equal(captured!.actorType, 'user'); // default
  assert.equal(captured!.resourceType, 'workspace_member');
  assert.equal(captured!.resourceId, 'user_1');
  assert.match(String(captured!.id), /^aud_/);
  assert.deepEqual(captured!.metadata, { from_role: 'member', to_role: 'admin' });
});

test('record() redacts sensitive metadata keys before persisting (defense-in-depth)', async () => {
  let captured: Record<string, unknown> | undefined;
  const db = fakeDb((_table, values) => {
    captured = values;
  });
  const svc = new AuditService(db);

  await svc.record({
    workspaceId: 'ws_1',
    category: 'connector',
    action: 'connector.created',
    resourceType: 'integration_out_config',
    metadata: { email: 'ana@loja.com', token: 'super-secret', platform: 'meta_capi' },
  });

  const metadata = captured!.metadata as Record<string, unknown>;
  assert.equal(metadata.email, '[REDACTED]');
  assert.equal(metadata.token, '[REDACTED]');
  assert.equal(metadata.platform, 'meta_capi');
});

test('record() never throws when the insert fails (best-effort, matches profile_access_log precedent)', async () => {
  const db = fakeDb(() => undefined, true);
  const svc = new AuditService(db);

  await assert.doesNotReject(
    svc.record({ workspaceId: 'ws_1', category: 'api_key', action: 'api_key.created', resourceType: 'api_key' }),
  );
});
