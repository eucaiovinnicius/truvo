import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TruvoEvent } from '@truvo/event-schema';
import { buildProjectionRequest } from './context-projection-hook';

function ev(over: Partial<TruvoEvent> & { properties?: Record<string, unknown> }): TruvoEvent {
  return {
    event_id: 'evt_1',
    event_name: 'page_view',
    source: 'pixel',
    workspace_id: 'ws_1',
    properties: {},
    context: {},
    ...over,
  } as TruvoEvent;
}

test('sem canonical_id resolvido → null (nada a anexar)', () => {
  assert.equal(buildProjectionRequest(ev({ event_name: 'purchase' }), undefined), null);
});

test('purchase com canonical_id → payload completo, sem mutar o evento original', () => {
  const event = ev({
    event_name: 'purchase',
    order_id: 'ord_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    properties: { value: 199.9, currency: 'BRL' },
  });
  const frozenProps = JSON.stringify(event.properties);

  const req = buildProjectionRequest(event, 'usr_abc');
  assert.ok(req);
  assert.equal(req!.workspace_id, 'ws_1');
  assert.equal(req!.canonical_id, 'usr_abc');
  assert.equal(req!.event.event_id, 'evt_1');
  assert.equal(req!.event.event_name, 'purchase');
  assert.equal(req!.event.order_id, 'ord_1');
  assert.equal(req!.event.properties.value, 199.9);
  assert.equal(req!.event.properties.currency, 'BRL');
  // o evento de origem não foi tocado (só lido) — prova de não-mutação (§ compat invariants).
  assert.equal(JSON.stringify(event.properties), frozenProps);
});

test('page_view genérico ainda monta payload (a decisão de projetar ou não é da regra, na API) — mas sem inventar campos', () => {
  const req = buildProjectionRequest(ev({ event_name: 'page_view' }), 'anon_x');
  assert.ok(req);
  assert.equal(req!.event.event_name, 'page_view');
  assert.deepEqual(req!.event.properties, {});
});
