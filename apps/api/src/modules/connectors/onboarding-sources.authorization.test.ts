import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Database } from '../auth/database.provider';
import { ROLES_KEY } from '../auth/decorators';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { ConnectorsController } from './connectors.controller';

type Role = 'owner' | 'admin' | 'member';
function fakeDb(role?: Role): Database {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => role ? [{ role }] : [] }) }) }) } as unknown as Database;
}
function context(userId: string, workspaceId: string, handler: Function): ExecutionContext {
  const req = { user: { id: userId }, params: { id: workspaceId }, headers: {} } as Record<string, unknown>;
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => ConnectorsController } as unknown as ExecutionContext;
}
function reflector() {
  return { getAllAndOverride: (_key: string, targets: Function[]) => targets.map((target) => Reflect.getMetadata(ROLES_KEY, target)).find(Boolean) } as unknown as import('@nestjs/core').Reflector;
}

test('actual onboarding-sources route allows owner/admin/member and denies non-members', async () => {
  const handler = ConnectorsController.prototype.listOnboardingSources;
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, handler), ['owner', 'admin', 'member']);
  for (const role of ['owner', 'admin', 'member'] as const) assert.equal(await new WorkspaceGuard(fakeDb(role), reflector()).canActivate(context('user-a', 'workspace-a', handler)), true);
  await assert.rejects(new WorkspaceGuard(fakeDb(), reflector()).canActivate(context('outsider', 'workspace-a', handler)), ForbiddenException);
  await assert.rejects(new WorkspaceGuard(fakeDb(), reflector()).canActivate(context('member-a', 'workspace-b', handler)), ForbiddenException);
});

test('member discovery permission does not extend to connector administration', async () => {
  const administrative = ['create', 'setCredentials', 'getOAuthAuthorizeUrl', 'oauthCallback', 'disconnect', 'triggerIncrementalSync', 'triggerBackfill'] as const;
  for (const method of administrative) {
    const handler = ConnectorsController.prototype[method];
    assert.deepEqual(Reflect.getMetadata(ROLES_KEY, handler), ['owner', 'admin'], method);
    await assert.rejects(new WorkspaceGuard(fakeDb('member'), reflector()).canActivate(context('member-a', 'workspace-a', handler)), ForbiddenException, method);
  }
});
