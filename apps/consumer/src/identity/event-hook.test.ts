import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TruvoEvent } from '@truvo/event-schema';
import { identifyRequestFromEvent, isIdentityTrigger, orderSourceRank } from './event-hook';

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

test('page_view anônimo sem identificador → null', () => {
  assert.equal(identifyRequestFromEvent(ev({ event_name: 'page_view' })), null);
});

test('page_view só com anonymous_id NÃO é trigger (precisa de user_id/order_id/nome-trigger)', () => {
  // Decisão de design: um page_view anônimo não dispara construção de identidade;
  // só identify/purchase (nome) ou eventos com user_id/order_id.
  assert.equal(isIdentityTrigger(ev({ anonymous_id: 'anon_1' })), false);
  assert.equal(identifyRequestFromEvent(ev({ anonymous_id: 'anon_1' })), null);
});

test('evento com user_id vira trigger e carrega o anonymous_id no request', () => {
  const req = identifyRequestFromEvent(ev({ user_id: 'u1', anonymous_id: 'anon_1' }));
  assert.ok(req);
  assert.equal(req!.user_id, 'u1');
  assert.equal(req!.anonymous_id, 'anon_1');
  assert.equal(req!.workspace_id, 'ws_1');
});

test('purchase é trigger de identidade', () => {
  assert.equal(isIdentityTrigger(ev({ event_name: 'purchase' })), true);
});

test('purchase com email_hash + order_id → request completo', () => {
  const req = identifyRequestFromEvent(
    ev({
      event_name: 'purchase',
      source: 'webhook',
      user_id: 'u1',
      order_id: 'ord_1',
      properties: { email_hash: 'hhh', phone_hash: 'ppp' },
      context: { utm_source: 'facebook', utm_medium: 'cpc' },
    }),
  );
  assert.ok(req);
  assert.equal(req!.user_id, 'u1');
  assert.equal(req!.order_id, 'ord_1');
  assert.equal(req!.email_hash, 'hhh');
  assert.equal(req!.phone_hash, 'ppp');
  assert.equal(req!.context?.utm_source, 'facebook');
});

test('orderSourceRank: webhook mais confiável que url', () => {
  assert.ok(orderSourceRank('webhook') < orderSourceRank('url'));
});

test('orderSourceRank: fonte desconhecida = menos confiável (rank alto)', () => {
  assert.ok(orderSourceRank('inexistente') >= orderSourceRank('url'));
});
