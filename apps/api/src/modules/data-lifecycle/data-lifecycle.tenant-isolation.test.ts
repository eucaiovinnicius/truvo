import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, isNull } from 'drizzle-orm';
import { createDb, customers, customerIdentifiers, customerTraits, dataLifecycleRequests } from '@truvo/db';
import { DataLifecycleService } from './data-lifecycle.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { AuditService } from '../audit/audit.service';

/**
 * Order 035 §5 — DATA LIFECYCLE (real-Postgres proof). Exercita o caminho batched
 * de `requestWorkspaceDeletion` (a única lógica que usa subquery + inArray, não
 * coberta pelos testes com DB fake) e reforça §1 (workspace B nunca é afetado pelo
 * tombstone de workspace A). Prova também RETRY-SAFETY: reexecutar sobre um
 * workspace já tombstoned processa zero linhas e completa sem erro (idempotente).
 *
 * Mesmo padrão de skip do `customer-context.tenant-isolation.test.ts` — ver
 * HANDOFF para o motivo do banco de dev estar inatingível nesta execução.
 */
let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.DATABASE_URL;
  if (!url) {
    reachable = false;
    return reachable;
  }
  const probe = postgres(url, { prepare: false, connect_timeout: 5, max: 1 });
  try {
    await probe.unsafe('select 1');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
  return reachable;
}

const STAMP = Date.now();
const WS_TARGET = `test_ws_lifecycle_${STAMP}`;
const WS_OTHER = `test_ws_lifecycle_other_${STAMP}`;

test('requestWorkspaceDeletion tombstones only the target workspace, retry-safely', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const svc = new DataLifecycleService(db, new CustomerContextService(db), new AuditService(db));
  const now = new Date();

  try {
    // 3 customers no workspace-alvo (com identifiers/traits em 2 deles) + 1 no outro workspace.
    await db.insert(customers).values([
      { workspaceId: WS_TARGET, id: 'c1', status: 'anonymous', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
      { workspaceId: WS_TARGET, id: 'c2', status: 'anonymous', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
      { workspaceId: WS_TARGET, id: 'c3', status: 'anonymous', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
      { workspaceId: WS_OTHER, id: 'other1', status: 'anonymous', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(customerIdentifiers).values([
      { workspaceId: WS_TARGET, id: `cid1_${STAMP}`, customerId: 'c1', identifierType: 'external_id', providerNamespace: 'order035-test', identifierValue: 'v1', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(customerTraits).values([
      { workspaceId: WS_TARGET, id: `ctr1_${STAMP}`, customerId: 'c2', traitNamespace: 'probe', traitKey: 'k', valueType: 'string', value: 'v', sourceNamespace: 'order035-test', observedAt: now },
    ]);

    // ── 1ª execução: deve tombstonar as 3 linhas do alvo, e SÓ elas ──
    const first = await svc.requestWorkspaceDeletion(WS_TARGET, { id: 'user_owner', email: 'owner@ws.com' });
    assert.equal(first.status, 'completed');
    assert.equal(first.counts.customers, 3);
    assert.equal(first.counts.identifiers, 1);
    assert.equal(first.counts.traits, 1);

    const remainingTarget = await db.select().from(customers).where(eq(customers.workspaceId, WS_TARGET));
    assert.ok(remainingTarget.every((c) => c.deletedAt !== null), 'todas as linhas do workspace-alvo devem estar tombstoned');

    const otherRows = await db.select().from(customers).where(eq(customers.workspaceId, WS_OTHER));
    assert.equal(otherRows.length, 1);
    assert.equal(otherRows[0]!.deletedAt, null, 'workspace B NUNCA deve ser afetado pelo tombstone de A');

    const request = await svc.getRequest(WS_TARGET, first.requestId);
    assert.equal(request?.status, 'completed');
    assert.equal(request?.kind, 'workspace_deletion');

    // ── 2ª execução (retry): já está tudo tombstoned → zero linhas processadas, sem erro ──
    const second = await svc.requestWorkspaceDeletion(WS_TARGET, { id: 'user_owner' });
    assert.equal(second.status, 'completed');
    assert.equal(second.counts.customers, 0);
    assert.equal(second.counts.identifiers, 0);
    assert.equal(second.counts.traits, 0);
  } finally {
    await db.delete(customers).where(eq(customers.workspaceId, WS_TARGET)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_OTHER)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, WS_TARGET)).catch(() => undefined);
  }
});

test('requestSubjectDeletion is idempotent (isNull guard) and workspace-scoped', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const svc = new DataLifecycleService(db, new CustomerContextService(db), new AuditService(db));
  const now = new Date();
  const ws = `test_ws_subject_${STAMP}`;

  try {
    await db.insert(customers).values({ workspaceId: ws, id: 'subject1', status: 'anonymous', sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now });

    const first = await svc.requestSubjectDeletion(ws, 'subject1', { id: 'user_owner' });
    assert.equal(first.status, 'completed');
    assert.equal(first.counts.customers, 1);

    const second = await svc.requestSubjectDeletion(ws, 'subject1', { id: 'user_owner' });
    assert.equal(second.status, 'completed');
    assert.equal(second.counts.customers, 0, 'reexecutar sobre um titular já tombstoned não deve reprocessar');

    const rows = await db.select().from(customers).where(eq(customers.workspaceId, ws));
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.deletedAt, null);
    assert.equal((await db.select().from(customers).where(isNull(customers.deletedAt))).some((c) => c.workspaceId === ws), false);
  } finally {
    await db.delete(customers).where(eq(customers.workspaceId, ws)).catch(() => undefined);
    await db.delete(dataLifecycleRequests).where(eq(dataLifecycleRequests.workspaceId, ws)).catch(() => undefined);
  }
});
