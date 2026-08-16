import assert from 'node:assert/strict';
import test from 'node:test';
import { isStrongIdentifier, STRONG_IDENTIFIER_TYPES, WEAK_IDENTIFIER_TYPES } from './identity-graph.policy';

test('user_id, email_hash, phone_hash, external_id, order_id são fortes', () => {
  for (const type of ['user_id', 'email_hash', 'phone_hash', 'external_id', 'order_id'] as const) {
    assert.equal(isStrongIdentifier(type), true, `${type} deveria ser forte`);
  }
});

test('click_id e anonymous_id são fracos', () => {
  for (const type of ['click_id', 'anonymous_id'] as const) {
    assert.equal(isStrongIdentifier(type), false, `${type} deveria ser fraco`);
  }
});

test('classificação é exaustiva e sem sobreposição (todo tipo é forte OU fraco, nunca ambos)', () => {
  const overlap = STRONG_IDENTIFIER_TYPES.filter((t) => (WEAK_IDENTIFIER_TYPES as string[]).includes(t));
  assert.equal(overlap.length, 0);
  assert.equal(STRONG_IDENTIFIER_TYPES.length + WEAK_IDENTIFIER_TYPES.length, 7, 'os 7 tipos de customer_identifier_type devem estar cobertos');
});
