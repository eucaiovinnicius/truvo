import assert from 'node:assert/strict';
import test from 'node:test';
import { isFeatureEnabled, parseFeatureFlags } from './feature-flags';

test('workspace override is isolated and unknown flags are disabled', () => {
  const flags = parseFeatureFlags('{"default":{"radar-preview":false},"workspaces":{"ws-a":{"radar-preview":true}}}');
  assert.equal(isFeatureEnabled(flags, 'ws-a', 'radar-preview'), true);
  assert.equal(isFeatureEnabled(flags, 'ws-b', 'radar-preview'), false);
  assert.equal(isFeatureEnabled(flags, 'ws-a', 'unknown-flag'), false);
});

test('invalid flag configuration is rejected before boot', () => {
  assert.throws(() => parseFeatureFlags('{"default":{"Not safe":true}}'));
  assert.throws(() => parseFeatureFlags('{"workspaces":[]}'));
});
