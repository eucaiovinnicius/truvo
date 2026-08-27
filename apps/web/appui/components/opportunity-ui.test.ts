import assert from 'node:assert/strict';
import test from 'node:test';
import { economicDisclosure, formatMoney, reconciliationCopy, signalLabel } from './opportunity-ui';

test('Opportunity UI states never present an old model as a new one', () => {
  assert.match(reconciliationCopy('waiting_for_scores').description, /antigos não serão apresentados/);
  assert.match(reconciliationCopy('materialization_failed').description, /versão anterior permaneceu intacta/);
});

test('economic disclosure distinguishes exact money, no-money and mixed currency', () => {
  assert.match(economicDisclosure('100.00'), /Não é receita incremental/);
  assert.match(economicDisclosure(null), /histórico monetário consistente insuficiente/);
  assert.match(economicDisclosure(null, 'mixed'), /Múltiplas moedas/);
  assert.match(formatMoney('100.00', 'BRL'), /100,00/);
});

test('unknown signals render safely without causal language', () => {
  assert.equal(signalLabel('unknown_future_code'), 'Unknown future code');
  assert.doesNotMatch(signalLabel('unknown_future_code'), /caus/);
});
