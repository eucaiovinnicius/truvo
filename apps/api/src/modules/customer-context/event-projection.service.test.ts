import assert from 'node:assert/strict';
import test from 'node:test';
import { customers, customerOutcomes } from '@truvo/db';
import { EventProjectionService } from './event-projection.service';
import type { Database } from '../auth/database.provider';

/** Fake mínimo do driver Drizzle cobrindo os padrões usados por EventProjectionService:
 * select(...).from(table).where().limit() — usado tanto pelo guard de supressão de
 * Order 055 (from(customers)) quanto pela pré-checagem de existência do outcome
 * (Order 040 closure — from(customerOutcomes), ver EventProjectionService#project) —
 * e insert(table).values(v).onConflictDoNothing()/.onConflictDoUpdate(), ambas
 * awaited direto (nenhum caminho usa .returning() mais). */
function fakeDb(opts: {
  onInsert?: (table: unknown, values: Record<string, unknown>) => void;
  /** simula o customer encontrado pelo guard de supressão — [{deletedAt: null}] (vivo) por padrão. */
  customerRows?: unknown[];
  /** simula uma linha JÁ existente de customer_outcomes para a natural key — [] (nenhuma) por padrão → deduped=false. */
  existingOutcomeRows?: unknown[];
} = {}) {
  const customerRows = opts.customerRows ?? [{ deletedAt: null }];
  const existingOutcomeRows = opts.existingOutcomeRows ?? [];
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === customerOutcomes ? existingOutcomeRows : customerRows),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        opts.onInsert?.(table, values);
        const chain = { then: (resolve: (v: undefined) => unknown) => Promise.resolve(undefined).then(resolve) };
        return { onConflictDoNothing: () => chain, onConflictDoUpdate: () => chain };
      },
    }),
  } as unknown as Database;
}

test('purchase com regra conhecida: grava catálogo (outcome_definitions) + observação (customer_outcomes)', async () => {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = fakeDb({ onInsert: (table, values) => inserts.push({ table, values }) });
  const svc = new EventProjectionService(db);

  const result = await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_1',
    event_name: 'purchase',
    order_id: 'ord_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    properties: { value: 199.9, currency: 'BRL' },
  });

  assert.equal(result.projected, true);
  assert.equal(result.deduped, false);
  assert.equal(inserts.length, 2, 'espera 1 insert em outcome_definitions + 1 em customer_outcomes');

  const outcomeInsert = inserts[1]!.values;
  assert.equal(outcomeInsert.workspaceId, 'ws_1');
  assert.equal(outcomeInsert.customerId, 'usr_abc');
  assert.equal(outcomeInsert.outcomeNamespace, 'commerce');
  assert.equal(outcomeInsert.outcomeKey, 'purchase');
  assert.equal(outcomeInsert.dedupeKey, 'ord_1', 'dedupe por order_id quando presente');
  assert.equal(outcomeInsert.value, '199.9');
  assert.equal(outcomeInsert.currency, 'BRL');
});

test('purchase sem order_id: dedupeKey cai para event_id', async () => {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = fakeDb({ onInsert: (table, values) => inserts.push({ table, values }) });
  const svc = new EventProjectionService(db);

  await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_2',
    event_name: 'purchase',
    properties: { value: 10, currency: 'USD' },
  });

  assert.equal(inserts[1]!.values.dedupeKey, 'evt_2');
});

test('replay do mesmo evento é idempotente: id determinístico + upsert de atribuição → deduped=true, sem duplicar', async () => {
  const db = fakeDb({ existingOutcomeRows: [{ id: 'row_1' }] }); // simula uma linha já existente para a natural key
  const svc = new EventProjectionService(db);

  const result = await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_1',
    event_name: 'purchase',
    order_id: 'ord_1',
    properties: { value: 50, currency: 'BRL' },
  });

  assert.equal(result.projected, true);
  assert.equal(result.deduped, true);
});

test('evento sem regra de projeção (ex.: page_view) não toca o banco — não fabrica trait/outcome', async () => {
  const inserts: unknown[] = [];
  const db = fakeDb({ onInsert: () => inserts.push(1) });
  const svc = new EventProjectionService(db);

  const result = await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_3',
    event_name: 'page_view',
    properties: {},
  });

  assert.equal(result.projected, false);
  assert.equal(result.reason, 'no_matching_rule');
  assert.equal(inserts.length, 0);
});

test('mesmo (workspace,namespace,key,dedupeKey) sempre gera o MESMO outcomeId — prova de determinismo', async () => {
  const db = fakeDb();
  const svc = new EventProjectionService(db);

  const a = await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_x',
    event_name: 'purchase',
    order_id: 'ord_9',
    properties: { value: 1, currency: 'BRL' },
  });
  const b = await svc.project('ws_1', 'usr_abc', {
    event_id: 'evt_y_replay_diferente_mas_mesmo_order', // reprocesso a partir de outra fonte/replay
    event_name: 'purchase',
    order_id: 'ord_9',
    properties: { value: 1, currency: 'BRL' },
  });

  assert.equal(a.outcomeId, b.outcomeId);
});

test('Order 055 §3: recusa projetar sob um customer tombstoned (deletedAt preenchido) — fail closed', async () => {
  const inserts: unknown[] = [];
  const db = fakeDb({ onInsert: () => inserts.push(1), customerRows: [{ deletedAt: new Date('2026-01-01') }] });
  const svc = new EventProjectionService(db);

  const result = await svc.project('ws_1', 'usr_deleted', {
    event_id: 'evt_deleted', event_name: 'purchase', order_id: 'ord_deleted', properties: { value: 1, currency: 'BRL' },
  });

  assert.equal(result.projected, false);
  assert.equal(result.reason, 'customer_suppressed');
  assert.equal(inserts.length, 0, 'nenhuma escrita deve acontecer para um customer removido');
});

test('Order 055 §3: recusa projetar quando o customer nem existe (canonicalId desconhecido)', async () => {
  const db = fakeDb({ customerRows: [] });
  const svc = new EventProjectionService(db);

  const result = await svc.project('ws_1', 'usr_nunca_existiu', {
    event_id: 'evt_missing', event_name: 'purchase', properties: {},
  });

  assert.equal(result.projected, false);
  assert.equal(result.reason, 'customer_suppressed');
});
