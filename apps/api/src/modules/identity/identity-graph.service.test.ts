import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityGraphService } from './identity-graph.service';
import type { Database } from '../auth/database.provider';
import type { CustomerContextService } from '../customer-context/customer-context.service';

/**
 * Guard-clause coverage that doesn't need a real transaction/unique-constraint —
 * the substantive proof (attach/merge/conflict/unmerge against real Postgres
 * constraints) lives in `identity-graph.tenant-isolation.test.ts`, matching the
 * order's own emphasis: a real-DB claim must not rest on a mocked constraint.
 */
function fakeDb(): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }) }) }),
  } as unknown as Database;
}

function fakeContext(): CustomerContextService {
  return {} as unknown as CustomerContextService;
}

test('mergeCustomers rejeita source === target sem tocar o banco', async () => {
  const svc = new IdentityGraphService(fakeDb(), fakeContext());
  await assert.rejects(
    () => svc.mergeCustomers({
      workspaceId: 'ws_1', sourceCustomerId: 'cus_a', targetCustomerId: 'cus_a',
      reason: 'test', sourceNamespace: 'test', actor: { type: 'system' },
    }),
    /must differ/,
  );
});

test('mergeCustomers rejeita quando source/target não existem no workspace', async () => {
  const svc = new IdentityGraphService(fakeDb(), fakeContext());
  await assert.rejects(
    () => svc.mergeCustomers({
      workspaceId: 'ws_1', sourceCustomerId: 'cus_a', targetCustomerId: 'cus_b',
      reason: 'test', sourceNamespace: 'test', actor: { type: 'system' },
    }),
    /not found in this workspace/,
  );
});

test('attachIdentifier/resolveOrCreateCustomer/recordConflict rejeitam providerNamespace vazio (assertNamespace reusado)', async () => {
  const svc = new IdentityGraphService(fakeDb(), fakeContext());
  await assert.rejects(() =>
    svc.recordConflict({
      workspaceId: 'ws_1', existingCustomerId: 'cus_a', incomingCustomerId: 'cus_b',
      providerNamespace: '', identifierType: 'email_hash', identifierValue: 'x',
      reason: 'test', sourceNamespace: 'test', detectedAt: new Date(),
    }),
  );
});

test('unmergeCustomers lança quando o merge event não existe', async () => {
  const svc = new IdentityGraphService(fakeDb(), fakeContext());
  await assert.rejects(
    () => svc.unmergeCustomers({ workspaceId: 'ws_1', mergeEventId: 'mev_nope', reason: 'test', actor: { type: 'system' } }),
    /merge event not found/,
  );
});

test('enqueueRetroactiveStitch é no-op sem merged_from (não enfileira nada)', async () => {
  const svc = new IdentityGraphService(fakeDb(), fakeContext());
  // Não deve lançar nem exigir Redis — early return puro.
  await svc.enqueueRetroactiveStitch('ws_1', 'cus_a', [], 'reason');
});
