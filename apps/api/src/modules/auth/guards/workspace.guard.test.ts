import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { WorkspaceGuard } from './workspace.guard';
import type { Database } from '../database.provider';

/**
 * Order 035 §1 — TENANT BOUNDARY (negative test). `WorkspaceGuard` é a fronteira
 * de autorização REUSADA por praticamente toda rota tenant-owned (M1, M6, M10,
 * customer-context/data-lifecycle novos deste order, etc.). Prova, de forma
 * determinística (sem depender de um Postgres real reachable — ver handoff), que
 * um usuário autenticado do workspace A NUNCA acessa o workspace B sem uma linha
 * de membership real: a query é o único portão, e aqui controlamos exatamente o
 * que ela "encontra" no banco.
 */
function fakeDb(membershipRows: Array<{ role: string }>): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => membershipRows,
        }),
      }),
    }),
  } as unknown as Database;
}

function fakeReflector(requiredRoles: string[] | undefined) {
  return { getAllAndOverride: () => requiredRoles } as unknown as import('@nestjs/core').Reflector;
}

function fakeContext(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as import('@nestjs/common').ExecutionContext;
}

test('workspace A user WITHOUT membership in workspace B → 403 (no cross-tenant read)', async () => {
  const guard = new WorkspaceGuard(fakeDb([]), fakeReflector(undefined)); // banco não retorna membership nenhuma
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: { id: 'ws_B' }, headers: {} };
  await assert.rejects(guard.canActivate(fakeContext(req)), ForbiddenException);
});

test('member of the workspace → passes and injects role', async () => {
  const guard = new WorkspaceGuard(fakeDb([{ role: 'admin' }]), fakeReflector(undefined));
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: { id: 'ws_A' }, headers: {} };
  const ok = await guard.canActivate(fakeContext(req));
  assert.equal(ok, true);
  assert.deepEqual(req.workspace, { id: 'ws_A', role: 'admin' });
});

test('unauthenticated request never reaches the membership check → 403', async () => {
  const guard = new WorkspaceGuard(fakeDb([{ role: 'owner' }]), fakeReflector(undefined));
  const req: Record<string, unknown> = { params: { id: 'ws_A' }, headers: {} }; // sem req.user
  await assert.rejects(guard.canActivate(fakeContext(req)), ForbiddenException);
});

test('missing workspace id (no :id param, no header) → 400, not silently allowed', async () => {
  const guard = new WorkspaceGuard(fakeDb([{ role: 'owner' }]), fakeReflector(undefined));
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: {}, headers: {} };
  await assert.rejects(guard.canActivate(fakeContext(req)), BadRequestException);
});

test('member with insufficient role for @Roles(...) → 403 even though membership exists', async () => {
  const guard = new WorkspaceGuard(fakeDb([{ role: 'member' }]), fakeReflector(['owner', 'admin']));
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: { id: 'ws_A' }, headers: {} };
  await assert.rejects(guard.canActivate(fakeContext(req)), ForbiddenException);
});

test('member WITH sufficient role for @Roles(...) → passes', async () => {
  const guard = new WorkspaceGuard(fakeDb([{ role: 'owner' }]), fakeReflector(['owner', 'admin']));
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: { id: 'ws_A' }, headers: {} };
  const ok = await guard.canActivate(fakeContext(req));
  assert.equal(ok, true);
});

test('header-based workspace resolution (no :id param) also enforces membership', async () => {
  const guard = new WorkspaceGuard(fakeDb([]), fakeReflector(undefined));
  const req: Record<string, unknown> = { user: { id: 'user_A' }, params: {}, headers: { 'x-workspace-id': 'ws_B' } };
  await assert.rejects(guard.canActivate(fakeContext(req)), ForbiddenException);
});
