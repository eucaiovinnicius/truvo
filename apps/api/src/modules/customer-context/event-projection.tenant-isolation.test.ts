import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import { createDb, closeDb, customers, customerOutcomes, outcomeDefinitions, identityLinks, identityMerges } from '@truvo/db';
import { IdentityService } from '../identity/identity.service';
import { closeRedis } from '../identity/identity.infra';
import { CustomerContextService } from './customer-context.service';
import { EventProjectionService } from './event-projection.service';

/**
 * Order 040 §5 — prova fim-a-fim contra Postgres real (mesmo padrão de
 * `customer-context.tenant-isolation.test.ts` / `data-lifecycle.tenant-isolation.test.ts`
 * do Order 035: SKIP explícito e visível se `DATABASE_URL` não estiver alcançável).
 *
 * Cobre exatamente o fluxo exigido pelo order: click/anonymous → events → identify
 * → purchase, resolvendo em UM canonical/outcome, idempotente em replay, e isolado
 * por workspace — sem tocar nada em ClickHouse (o "evento histórico" aqui é o objeto
 * `properties`/`event` passado ao projetor; provamos que ele não é mutado).
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
const WS_A = `test_ws_proj_a_${STAMP}`;
const WS_B = `test_ws_proj_b_${STAMP}`;

test('anonymous → identify → purchase: resolve em UM canonical/outcome, idempotente e isolado por workspace', async (t) => {
  if (!(await checkReachable())) {
    t.skip('DATABASE_URL não alcançável neste ambiente — ver HANDOFF (Postgres dev unreachable)');
    return;
  }

  const db = createDb();
  const customerContext = new CustomerContextService(db);
  const identity = new IdentityService(db, customerContext);
  const projection = new EventProjectionService(db);

  try {
    // 1. click/anonymous: um identify anônimo prévio (pixel), sem user_id ainda.
    const anon = await identity.identify(WS_A, { anonymous_id: `anon_${STAMP}`, source: 'pixel' });
    assert.equal(anon.identified, false);

    // 2. identify: o mesmo visitante se identifica (login/checkout) — carrega o
    //    anonymous_id anterior + user_id novo. M8 funde os dois canonicals.
    const identified = await identity.identify(WS_A, {
      anonymous_id: `anon_${STAMP}`,
      user_id: `u_${STAMP}`,
      source: 'api',
    });
    assert.equal(identified.canonical_id, `usr_u_${STAMP}`);
    assert.ok(identified.merged, 'esperava fusão do canonical anônimo no identificado');

    // 3. purchase: o evento de compra chega com order_id — a projeção observa o
    //    outcome canônico no MESMO customer que acabou de ser resolvido pelo M8.
    const purchaseEvent = {
      event_id: `evt_purchase_${STAMP}`,
      event_name: 'purchase',
      order_id: `ord_${STAMP}`,
      timestamp: new Date().toISOString(),
      properties: { value: 249.9, currency: 'BRL' },
    };
    const frozenEvent = JSON.parse(JSON.stringify(purchaseEvent));

    const first = await projection.project(WS_A, identified.canonical_id, purchaseEvent);
    assert.equal(first.projected, true);
    assert.equal(first.deduped, false);

    // o objeto do evento passado ao projetor não foi mutado (compat invariant: não
    // reescrever/mutar o payload de origem).
    assert.deepEqual(purchaseEvent, frozenEvent);

    // ── UM canonical/outcome: só existe uma linha de outcome, presa ao canonical certo ──
    const outcomeRows = await db
      .select()
      .from(customerOutcomes)
      .where(and(eq(customerOutcomes.workspaceId, WS_A), eq(customerOutcomes.outcomeKey, 'purchase')));
    assert.equal(outcomeRows.length, 1);
    assert.equal(outcomeRows[0]!.customerId, identified.canonical_id);
    assert.equal(outcomeRows[0]!.value, '249.9');
    assert.equal(outcomeRows[0]!.dedupeKey, `ord_${STAMP}`);

    const anonCustomer = await db
      .select()
      .from(customers)
      .where(and(eq(customers.workspaceId, WS_A), eq(customers.id, `anon_anon_${STAMP}`)));
    assert.equal(anonCustomer[0]?.status, 'merged', 'o canonical anônimo perdedor deve estar marcado merged');
    assert.equal(anonCustomer[0]?.mergedIntoCustomerId, identified.canonical_id);

    // ── idempotência em replay: reprocessar o MESMO evento não duplica o outcome ──
    const replay = await projection.project(WS_A, identified.canonical_id, purchaseEvent);
    assert.equal(replay.projected, true);
    assert.equal(replay.deduped, true);
    assert.equal(replay.outcomeId, first.outcomeId);

    const outcomeRowsAfterReplay = await db
      .select()
      .from(customerOutcomes)
      .where(and(eq(customerOutcomes.workspaceId, WS_A), eq(customerOutcomes.outcomeKey, 'purchase')));
    assert.equal(outcomeRowsAfterReplay.length, 1, 'replay não deve criar uma segunda linha de outcome');

    // ── isolamento por workspace: o MESMO order_id em outro workspace é um outcome DIFERENTE ──
    const otherIdentify = await identity.identify(WS_B, { user_id: `u_${STAMP}`, source: 'api' });
    const otherProjection = await projection.project(WS_B, otherIdentify.canonical_id, {
      ...purchaseEvent,
      event_id: `evt_purchase_other_${STAMP}`,
    });
    assert.equal(otherProjection.deduped, false, 'workspace B nunca deve colidir com o dedupe de A');

    const wsAOnly = await db.select().from(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS_A));
    assert.ok(wsAOnly.every((r) => r.workspaceId === WS_A));

    // catálogo (outcome_definitions) foi criado uma única vez por workspace (idempotente).
    const definitions = await db
      .select()
      .from(outcomeDefinitions)
      .where(and(eq(outcomeDefinitions.workspaceId, WS_A), eq(outcomeDefinitions.outcomeKey, 'purchase')));
    assert.equal(definitions.length, 1);
  } finally {
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(customerOutcomes).where(eq(customerOutcomes.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(outcomeDefinitions).where(eq(outcomeDefinitions.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(outcomeDefinitions).where(eq(outcomeDefinitions.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(customers).where(eq(customers.workspaceId, WS_B)).catch(() => undefined);
    await db.delete(identityMerges).where(eq(identityMerges.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(identityLinks).where(eq(identityLinks.workspaceId, WS_A)).catch(() => undefined);
    await db.delete(identityLinks).where(eq(identityLinks.workspaceId, WS_B)).catch(() => undefined);
    // identity.identify() aciona getRedis() (enqueueRetroStitch) quando há merge —
    // sem isto, o client do ioredis mantém o event loop vivo indefinidamente
    // tentando reconectar (achado desta execução, ver identity.infra.ts#closeRedis).
    closeRedis();
    await closeDb(db).catch(() => undefined);
  }
});
