import assert from 'node:assert/strict';
import test from 'node:test';
import { DataLifecycleService } from './data-lifecycle.service';
import type { Database } from '../auth/database.provider';
import type { AuditService } from '../audit/audit.service';
import type { CustomerContextService } from '../customer-context/customer-context.service';
import type { SuppressionService } from '../customer-context/suppression.service';
import type { CustomerContext } from '../customer-context/customer-context.contracts';

/** Fake mínimo do driver Drizzle cobrindo os padrões usados por DataLifecycleService
 * nos caminhos SEM subquery: insert().values(), update().set().where() (sem
 * .returning()) e update(...).returning() (tombstoneSubject). */
function fakeDb(opts: {
  onInsert?: (table: unknown, values: Record<string, unknown>) => void;
  onUpdate?: (table: unknown, patch: Record<string, unknown>) => void;
  returningRows?: unknown[];
} = {}) {
  const returning = opts.returningRows ?? [{ id: 'row_1' }];
  return {
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
        opts.onInsert?.(table, Array.isArray(values) ? values[0]! : values);
        return [];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        opts.onUpdate?.(table, patch);
        const whereResult: Record<string, unknown> & PromiseLike<unknown[]> = {
          returning: async () => returning,
          then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        } as never;
        return { where: () => whereResult };
      },
    }),
  } as unknown as Database;
}

function fakeAudit(capture: { calls: Array<Record<string, unknown>> }): AuditService {
  return { record: async (input: Record<string, unknown>) => { capture.calls.push(input); } } as unknown as AuditService;
}

function fakeContext(context: CustomerContext | null | (() => CustomerContext | null)): CustomerContextService {
  return {
    getContext: async () => (typeof context === 'function' ? context() : context),
  } as unknown as CustomerContextService;
}

function fakeSuppression(): SuppressionService {
  return { isSuppressed: async () => false } as unknown as SuppressionService;
}

const SAMPLE_CONTEXT: CustomerContext = {
  customer: {
    workspaceId: 'ws_1', id: 'cus_1', legacyCanonicalId: null, status: 'identified',
    mergedIntoCustomerId: null, sourceNamespace: 'test', provenance: {},
    firstSeenAt: new Date(), lastSeenAt: new Date(), retentionUntil: null, deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  },
  identifiers: [],
  current_traits: [],
  relationships: [],
  behavior_references: [{ store: 'clickhouse', dataset: 'events', workspace_id: 'ws_1', customer_id: 'cus_1', legacy_canonical_id: null }],
  context_references: [],
};

test('requestSubjectExport: assembles context, audits, and logs LGPD profile access (export)', async () => {
  const auditCalls: Array<Record<string, unknown>> = [];
  const insertedTables: unknown[] = [];
  const db = fakeDb({ onInsert: (table) => insertedTables.push(table) });
  const svc = new DataLifecycleService(db, fakeContext(SAMPLE_CONTEXT), fakeAudit({ calls: auditCalls }), fakeSuppression());

  const result = await svc.requestSubjectExport('ws_1', 'cus_1', { id: 'user_owner', email: 'owner@ws.com' });

  assert.equal(result.status, 'completed');
  assert.ok(result.context);
  assert.equal(result.context!.customer.id, 'cus_1');
  assert.ok(result.lineage.length > 0, 'lineage classification deve estar presente');
  assert.match(result.requestId, /^dlr_/);

  // audit_log recebeu o evento de export
  const auditAction = auditCalls.find((c) => c.action === 'data_lifecycle.subject_export');
  assert.ok(auditAction, 'esperava um audit record data_lifecycle.subject_export');
  assert.equal(auditAction!.resourceId, 'cus_1');

  // 2 inserts: data_lifecycle_requests (registro do pedido) + profile_access_log (LGPD, reuso)
  assert.equal(insertedTables.length, 2);
});

test('requestSubjectExport: getContext failing marks the request failed but never throws', async () => {
  const auditCalls: Array<Record<string, unknown>> = [];
  const db = fakeDb();
  const failingContext = { getContext: async () => { throw new Error('clickhouse down'); } } as unknown as CustomerContextService;
  const svc = new DataLifecycleService(db, failingContext, fakeAudit({ calls: auditCalls }), fakeSuppression());

  const result = await svc.requestSubjectExport('ws_1', 'cus_1', { id: 'user_owner' });
  assert.equal(result.status, 'failed');
  assert.equal(result.context, null);
  const auditAction = auditCalls.find((c) => c.action === 'data_lifecycle.subject_export');
  const metadata = auditAction!.metadata as Record<string, unknown>;
  assert.equal(metadata.status, 'failed');
});

// `requestSubjectDeletion`'s substantive proof moved to
// `data-lifecycle.subject-erasure.test.ts` (real Postgres + real ClickHouse,
// Order 055) — the new per-store orchestration calls the real erasure registry
// (drizzle query chains this fake db doesn't model, plus a real ClickHouse client),
// so a fake-db unit test here would either mock so much it proves nothing, or
// diverge from the real DB. Same posture Order 045 took for `mergeCustomers`/etc.

test('getRequest returns null for an unknown request id (no throw)', async () => {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Database;
  const svc = new DataLifecycleService(db, fakeContext(null), fakeAudit({ calls: [] }), fakeSuppression());
  const result = await svc.getRequest('ws_1', 'dlr_missing');
  assert.equal(result, null);
});
