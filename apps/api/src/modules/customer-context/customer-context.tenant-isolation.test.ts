import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, customers } from '@truvo/db';
import { CustomerContextService } from './customer-context.service';

/**
 * Order 035 §1 — TENANT BOUNDARY (real-Postgres negative proof). Prova, contra um
 * banco de verdade, que workspace A NUNCA lê/muta uma linha da workspace B mesmo
 * quando ambas compartilham o MESMO id natural — a chave primária composta
 * `(workspace_id, id)` (packages/db/src/schema/customer-context.ts) é a garantia;
 * este teste EXERCITA essa garantia fim-a-fim via `CustomerContextService`.
 *
 * Roda SÓ quando `DATABASE_URL` está alcançável. SKIP explícito (visível como
 * "skipped" no TAP, nunca silenciosamente "passed") caso contrário — ver o
 * HANDOFF desta execução: o projeto Supabase de dev configurado no `.env` estava
 * inatingível neste ambiente (rede alcança o pooler, tenant não resolve).
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
const WS_A = `test_ws_a_${STAMP}`;
const WS_B = `test_ws_b_${STAMP}`;
const SHARED_ID = `test_shared_${STAMP}`;

test('workspace A cannot read/mutate a same-id customer row owned by workspace B', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const service = new CustomerContextService(db);
  const now = new Date();

  try {
    await db.insert(customers).values([
      {
        workspaceId: WS_A, id: SHARED_ID, status: 'anonymous', sourceNamespace: 'order035-test',
        firstSeenAt: now, lastSeenAt: now, provenance: { imported_by: 'ws-a-marker' },
      },
      {
        workspaceId: WS_B, id: SHARED_ID, status: 'anonymous', sourceNamespace: 'order035-test',
        firstSeenAt: now, lastSeenAt: now, provenance: { imported_by: 'ws-b-marker' },
      },
    ]);

    const ctxA = await service.getContext(WS_A, SHARED_ID);
    const ctxB = await service.getContext(WS_B, SHARED_ID);
    assert.ok(ctxA, 'workspace A deve enxergar sua própria linha');
    assert.ok(ctxB, 'workspace B deve enxergar sua própria linha');
    assert.equal(ctxA!.customer.provenance?.imported_by, 'ws-a-marker');
    assert.equal(ctxB!.customer.provenance?.imported_by, 'ws-b-marker');
    // A garantia central: mesmo id natural, cada workspace só vê SUA marca.
    assert.notEqual(ctxB!.customer.provenance?.imported_by, 'ws-a-marker');

    // Isolamento de ESCRITA: um upsert de trait escopado a A não pode aparecer em B.
    await service.upsertTrait({
      type: 'string', value: 'only-a', workspaceId: WS_A, customerId: SHARED_ID,
      traitNamespace: 'order035_probe', traitKey: 'k', sourceNamespace: 'order035-test', observedAt: now,
    });
    const ctxBAfter = await service.getContext(WS_B, SHARED_ID);
    assert.equal(
      ctxBAfter!.current_traits.find((tr) => tr.traitNamespace === 'order035_probe'),
      undefined,
      'trait escrita sob workspace A vazou para workspace B',
    );

    // resolveIdentifier também é workspace-scoped (mesmo provider/tipo/valor sob A e B).
    const idA = `${SHARED_ID}_ident`;
    await db.insert((await import('@truvo/db')).customerIdentifiers).values([
      { workspaceId: WS_A, id: `cid_a_${STAMP}`, customerId: SHARED_ID, identifierType: 'external_id', providerNamespace: 'order035-test', identifierValue: idA, sourceNamespace: 'order035-test', firstSeenAt: now, lastSeenAt: now },
    ]);
    const resolvedInA = await service.resolveIdentifier(WS_A, 'order035-test', 'external_id', idA);
    const resolvedInB = await service.resolveIdentifier(WS_B, 'order035-test', 'external_id', idA);
    assert.equal(resolvedInA, SHARED_ID);
    assert.equal(resolvedInB, null, 'identifier de A resolveu sob o escopo de B');
  } finally {
    await db.delete(customers).where(eq(customers.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_B)).catch(() => undefined);
  }
});
