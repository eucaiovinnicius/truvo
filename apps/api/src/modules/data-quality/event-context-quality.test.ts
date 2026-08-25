import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSample, validateEventQuality } from './event-context-quality.service';

test('quality engine detects identifier, unknown name, required property, type and timestamp defects', () => {
  const issues = validateEventQuality({ eventName: 'purchase', identifiers: {}, properties: { amount: 'bad' }, timestamp: 'not-a-date' }, { knownEventNames: ['signup'], requiredProperties: { amount: 'number', currency: 'string' } });
  assert.deepEqual(issues.map((i) => i.category), ['event', 'schema_drift', 'schema_drift', 'schema_drift', 'event']);
});
test('quality engine flags drift with an explicit recommendation and redacts sensitive samples', () => {
  const issues = validateEventQuality({ eventName: 'signup', identifiers: { id: 'x' }, properties: { provider_field: 1, email: 'a@b.test' } }, { knownEventNames: ['signup'], observedProperties: ['canonical_field'] });
  assert.equal(issues.some((i) => i.actionCode === 'resolve_schema_drift'), true);
  assert.deepEqual(redactSample({ email: 'a@b.test', token: 'secret', safe: 'ok' }), { safe: 'ok' });
});
