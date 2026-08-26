import assert from 'node:assert/strict';
import test from 'node:test';
import { audienceSummary, defaultAudience, modelState, readinessCopy, statusLabel, type AudienceAst } from './radar-ui';

test('Radar audience builder maps only supported controls to the canonical AST', () => {
  const trait: AudienceAst = { version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' };
  const combined: AudienceAst = { version: 1, op: 'and', children: [defaultAudience, { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'purchase' }] };
  assert.deepEqual(defaultAudience, { version: 1, op: 'identified' });
  assert.equal(audienceSummary(trait), 'Clientes com country igual a BR');
  assert.match(audienceSummary(combined, [{ id: 'purchase', name: 'Compra', kind: 'event' }]), /clientes identificáveis.*Compra/i);
});

test('Radar readiness copy keeps blockers distinct from non-blocking activation warnings', () => {
  assert.match(readinessCopy('insufficient_history'), /histórico suficiente/);
  assert.match(readinessCopy('activation_destination_unavailable'), /não impede validar/);
});

test('Radar model state never presents a previous model as current after a semantic definition change', () => {
  assert.equal(modelState({ status: 'draft', current_definition_version: 2, current_model_reference: null }), 'A definição atual mudou e precisa ser validada novamente');
  assert.equal(modelState({ status: 'active', current_definition_version: 1, current_model_reference: 'model-v1' }), 'Modelo ativo para a definição atual');
  assert.equal(statusLabel('ready_to_train'), 'Pronto para treinar');
});
