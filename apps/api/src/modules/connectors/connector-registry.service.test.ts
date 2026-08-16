import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorRegistryService } from './connector-registry.service';
import { createFakeProviderState, createFakeSourceAdapter, createFakeDestinationAdapter, FAKE_PROVIDER } from './testing/fake-provider.adapter';

test('registry: unregistered provider returns undefined for both adapter kinds', () => {
  const registry = new ConnectorRegistryService();
  assert.equal(registry.getSourceAdapter('nope'), undefined);
  assert.equal(registry.getDestinationAdapter('nope'), undefined);
  assert.equal(registry.getDefinition('nope'), undefined);
});

test('registry: registering source and destination adapters for the same provider merges into one definition', () => {
  const registry = new ConnectorRegistryService();
  const state = createFakeProviderState();
  registry.registerSource(createFakeSourceAdapter(state));
  registry.registerDestination(createFakeDestinationAdapter(state));

  assert.ok(registry.getSourceAdapter(FAKE_PROVIDER));
  assert.ok(registry.getDestinationAdapter(FAKE_PROVIDER));
  assert.equal(registry.listDefinitions().length, 1);
  assert.equal(registry.getDefinition(FAKE_PROVIDER)!.role, 'bidirectional');
});
