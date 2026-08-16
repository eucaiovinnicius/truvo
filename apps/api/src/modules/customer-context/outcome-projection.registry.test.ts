import assert from 'node:assert/strict';
import test from 'node:test';
import { findOutcomeProjectionRule, OUTCOME_PROJECTION_RULES } from './outcome-projection.registry';

test('purchase tem regra explícita (commerce.purchase, dedupe por order_id)', () => {
  const rule = findOutcomeProjectionRule('purchase');
  assert.ok(rule);
  assert.equal(rule!.outcomeNamespace, 'commerce');
  assert.equal(rule!.outcomeKey, 'purchase');
  assert.equal(rule!.dedupeFrom, 'order_id');
  assert.equal(rule!.valueProperty, 'value');
  assert.equal(rule!.currencyProperty, 'currency');
});

test('subscription_started tem regra explícita', () => {
  const rule = findOutcomeProjectionRule('subscription_started');
  assert.ok(rule);
  assert.equal(rule!.outcomeKey, 'subscription_started');
});

test('page_view (evento genérico) não tem regra — não deve fabricar outcome/trait', () => {
  assert.equal(findOutcomeProjectionRule('page_view'), undefined);
});

test('evento custom/desconhecido não tem regra — projeta nada, continua válido', () => {
  assert.equal(findOutcomeProjectionRule('minha_conversao_customizada'), undefined);
});

test('refund/subscription_cancelled deliberadamente fora do registro (ver comentário do arquivo)', () => {
  assert.equal(findOutcomeProjectionRule('refund'), undefined);
  assert.equal(findOutcomeProjectionRule('subscription_cancelled'), undefined);
});

test('registro é uma lista fixa e revisável — nenhuma regra duplica event_name', () => {
  const names = OUTCOME_PROJECTION_RULES.map((r) => r.eventName);
  assert.equal(new Set(names).size, names.length);
});
