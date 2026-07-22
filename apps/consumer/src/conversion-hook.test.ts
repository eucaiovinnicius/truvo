import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TruvoEvent } from '@truvo/event-schema';
import { conversionForwardFromEvent } from './conversion-hook';

function ev(over: Partial<TruvoEvent> & { properties?: Record<string, unknown> }): TruvoEvent {
  return {
    event_id: 'evt_1',
    event_name: 'purchase',
    source: 'webhook',
    workspace_id: 'ws_1',
    properties: {},
    context: {},
    ...over,
  } as TruvoEvent;
}

test('evento não-conversão (page_view) → null', () => {
  assert.equal(conversionForwardFromEvent(ev({ event_name: 'page_view', user_id: 'u1' })), null);
});

test('conversão sem NENHUMA match key → null (envio seria inútil)', () => {
  assert.equal(conversionForwardFromEvent(ev({ event_name: 'purchase', anonymous_id: 'a1' })), null);
});

test('purchase com email_hash + valor → monta input com match keys e consentimento', () => {
  const out = conversionForwardFromEvent(
    ev({
      event_name: 'purchase',
      event_id: 'evt_9',
      order_id: 'ord_9',
      user_id: 'u9',
      click_id: 'fbclid_x',
      timestamp: '2026-07-20T12:00:00.000Z',
      properties: { value: 349.9, currency: 'BRL', email_hash: 'abc123', consent: { granted: true } },
      context: { page_url: 'https://loja/checkout', user_agent: 'UA' },
    }),
  );
  assert.ok(out, 'não é null');
  assert.equal(out!.eventId, 'evt_9');
  assert.equal(out!.eventName, 'purchase');
  assert.equal(out!.orderId, 'ord_9');
  assert.equal(out!.value, 349.9);
  assert.equal(out!.currency, 'BRL');
  assert.equal(out!.consent.granted, true);
  assert.equal(out!.matchKeys.email, 'abc123');
  assert.equal(out!.matchKeys.clickId, 'fbclid_x');
  assert.equal(out!.matchKeys.externalId, 'u9'); // user_id vira external_id
  assert.equal(out!.matchKeys.userAgent, 'UA');
  assert.equal(out!.timestampMs, Date.parse('2026-07-20T12:00:00.000Z'));
});

test('sem consent → granted:false (fail-closed, regra 13)', () => {
  const out = conversionForwardFromEvent(ev({ event_name: 'lead', properties: { email_hash: 'h' } }));
  assert.ok(out);
  assert.equal(out!.consent.granted, false);
});

test('lead com só user_id ainda é encaminhável (externalId)', () => {
  const out = conversionForwardFromEvent(ev({ event_name: 'lead', user_id: 'u2' }));
  assert.ok(out);
  assert.equal(out!.matchKeys.externalId, 'u2');
});
