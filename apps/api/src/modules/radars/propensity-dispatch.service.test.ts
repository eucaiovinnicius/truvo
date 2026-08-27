import test from 'node:test';
import assert from 'node:assert/strict';
import { PropensityDispatchService, PROPENSITY_TRAINING_TOPIC } from './propensity-dispatch.service';

test('propensity Kafka wake-up is minimal, PII-free and keyed by durable request', async () => {
  const published: Array<{ topic: string; key: string; value: unknown }> = [];
  const kafka = { publish: async (topic: string, key: string, value: unknown) => { published.push({ topic, key, value }); } };
  const db = { execute: async () => [] };
  const service = new PropensityDispatchService(db as never, kafka as never);
  await service.dispatchTraining({ workspace_id: 'workspace-a', radar_id: 'radar-a', definition_version: 3, id: 'request-a', correlation_id: 'correlation-a' });
  assert.equal(published.length, 1);
  assert.equal(published[0]!.topic, PROPENSITY_TRAINING_TOPIC);
  assert.equal(published[0]!.key, 'workspace-a:request-a');
  assert.deepEqual(published[0]!.value, { workspaceId: 'workspace-a', radarId: 'radar-a', definitionVersion: 3, trainingRequestId: 'request-a', correlationId: 'correlation-a' });
  assert.equal(/email|phone|name|address|token|secret/i.test(JSON.stringify(published[0]!.value)), false);
});
