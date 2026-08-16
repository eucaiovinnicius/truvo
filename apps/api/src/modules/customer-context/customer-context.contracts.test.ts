import assert from 'node:assert/strict';
import test from 'node:test';
import { eventSchema } from '@truvo/event-schema';
import { assertNamespace, normalizeTraitValue } from './customer-context.contracts';

test('typed traits normalize deterministically and reject invalid values', () => {
  assert.equal(normalizeTraitValue({ type: 'string', value: '42' }), '42');
  assert.equal(normalizeTraitValue({ type: 'number', value: 42 }), 42);
  assert.equal(normalizeTraitValue({ type: 'datetime', value: '2026-08-16T10:00:00-03:00' }), '2026-08-16T13:00:00.000Z');
  assert.throws(() => normalizeTraitValue({ type: 'number', value: Number.NaN }));
});

test('provider namespaces are explicit and canonicalized', () => {
  assert.equal(assertNamespace(' HubSpot.CRM ', 'provider'), 'hubspot.crm');
  assert.throws(() => assertNamespace('', 'provider'));
  assert.throws(() => assertNamespace('provider field', 'provider'));
});

test('EventSchema remains compatible with an existing v3.2 event', () => {
  const parsed = eventSchema.parse({
    event_id: 'evt_legacy', event_name: 'purchase', source: 'webhook',
    workspace_id: 'ws_1', anonymous_id: 'anon_1', user_id: 'u_1', order_id: 'ord_1',
    properties: { value: 199.9, email_hash: 'abc' }, context: { utm_source: 'google' },
  });
  assert.equal(parsed.event_name, 'purchase');
  assert.equal(parsed.order_id, 'ord_1');
});
