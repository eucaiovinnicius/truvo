import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RADAR_MINIMUM_DATA_POLICY,
  RADAR_WINDOWS,
  normalizeRadarDefinition,
  validateAudienceAst,
} from './radar.service';
import { createRadarSchema, patchRadarSchema, trainRadarSchema } from './radar.dto';

test('Radar v1 accepts only the bounded canonical audience AST', () => {
  assert.deepEqual(RADAR_WINDOWS, [7, 14, 30, 60]);
  assert.deepEqual(validateAudienceAst({ version: 1, op: 'identified' }), { version: 1, op: 'identified' });
  assert.equal(validateAudienceAst({ version: 1, op: 'trait', key: 'country', operator: 'eq', value: 'BR' }).op, 'trait');
  assert.equal(validateAudienceAst({ version: 1, op: 'trait', key: 'subscribed', operator: 'eq', value: true }).op, 'trait');
  assert.equal(validateAudienceAst({ version: 1, op: 'trait', key: 'score', operator: 'eq', value: 5 }).op, 'trait');
  assert.equal(validateAudienceAst({ version: 1, op: 'and', children: [{ version: 1, op: 'identified' }, { version: 1, op: 'outcome_occurred', outcomeDefinitionId: 'out_1' }] }).op, 'and');

  const malicious: unknown[] = [
    'SELECT * FROM customers',
    { version: 1, op: 'sql', value: 'DROP TABLE customers' },
    { version: 1, op: 'table', name: 'customers' },
    { version: 1, op: 'column', name: 'email' },
    { version: 1, op: 'trait', key: '$.secret', operator: 'eq', value: 'x' },
    { version: 1, op: 'trait', key: 'x;drop', operator: 'eq', value: 'BR' },
    { version: 1, op: 'trait', key: 'country', operator: 'contains', value: 'B' },
    { version: 1, op: 'trait', key: 'country', operator: 'eq', value: null },
    { version: 1, op: 'unknown' },
  ];
  for (const payload of malicious) assert.throws(() => validateAudienceAst(payload));

  let nested: unknown = { version: 1, op: 'identified' };
  for (let index = 0; index < 10; index += 1) {
    nested = { version: 1, op: 'and', children: [nested, { version: 1, op: 'identified' }] };
  }
  assert.throws(() => validateAudienceAst(nested), /maximum depth/);
});

test('persisted definitions normalize driver objects and JSON strings at one boundary', () => {
  const row = {
    workspace_id: 'workspace',
    radar_id: 'radar',
    version: 1,
    outcome_definition_id: 'purchase',
    audience_ast: '{"version":1,"op":"identified"}',
    prediction_window_days: 30,
    optimization_goal: '{"metric":"occurrence"}',
    activation_destination: '{"connectionId":"destination","capability":"activation","activationReady":false}',
    readiness: '{"status":"ready_to_train"}',
    created_at: new Date(),
  };
  const normalized = normalizeRadarDefinition(row);
  assert.deepEqual(normalized.audience_ast, { version: 1, op: 'identified' });
  assert.deepEqual(normalized.optimization_goal, { metric: 'occurrence' });
  assert.deepEqual(normalized.activation_destination, { connectionId: 'destination', capability: 'activation' });
  assert.deepEqual(normalized.readiness, { status: 'ready_to_train' });
  assert.throws(() => normalizeRadarDefinition({ ...row, audience_ast: 'not-json' }), /Persisted Radar audience definition is invalid/);
  assert.throws(() => normalizeRadarDefinition({ ...row, readiness: '[]' }), /Persisted Radar readiness is invalid/);
});

test('Radar readiness policy defaults are centralized', () => {
  assert.deepEqual(RADAR_MINIMUM_DATA_POLICY, {
    minLabeledExamples: 1000,
    minPositives: 100,
    minNegatives: 100,
  });
});

test('HTTP DTO boundary rejects invalid windows/keys and does not expose client status mutation', () => {
  const base = { name: 'Purchase radar', outcomeDefinitionId: 'purchase', predictionWindowDays: 30 as const };
  assert.equal(createRadarSchema.safeParse(base).success, true);
  assert.equal(createRadarSchema.safeParse({ ...base, predictionWindowDays: 365 }).success, false);
  assert.equal(createRadarSchema.safeParse({ ...base, predictionWindowDays: '30' }).success, false);
  assert.equal(trainRadarSchema.safeParse({ idempotencyKey: 'too-short' }).success, true);
  assert.equal(trainRadarSchema.safeParse({ idempotencyKey: 'short' }).success, false);
  const patched = patchRadarSchema.parse({ name: 'Renamed', status: 'active' });
  assert.deepEqual(patched, { name: 'Renamed' });
});
