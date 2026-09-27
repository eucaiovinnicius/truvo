/**
 * ORDER 130 — Acceptance Proof: DEMO DATA
 * Verifies versioning, determinism, portability, six personas, and zero secrets/PII.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  getSyntheticDatasetV1,
  SYNTHETIC_DATASET_V1,
  validateSyntheticDataset,
} from './fixtures/synthetic-dataset.v1';
import { assertNoSecrets } from './fixtures/connector-fixtures';
import { QaDemoWorkspaceService } from './qa-demo-workspace.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { FAKE_PROVIDER } from '../connectors/testing/fake-provider.adapter';

function checksum(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

test('DEMO DATA: versioned, deterministic, portable', () => {
  const dataset1 = getSyntheticDatasetV1();
  const dataset2 = getSyntheticDatasetV1();

  // Versioning
  assert.equal(dataset1.version, '1.0.0');

  // Fixed Clock
  assert.equal(dataset1.fixedClock, '2026-08-01T12:00:00.000Z');
  assert.equal(Number.isNaN(Date.parse(dataset1.fixedClock)), false);

  // Determinism
  assert.deepEqual(dataset1, dataset2);
  assert.equal(checksum(dataset1), checksum(dataset2));

  // Validation
  const validation = validateSyntheticDataset(dataset1);
  assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join('; ')}`);
  assert.equal(validation.personasCount, 6);
});

test('DEMO DATA: six personas cover all required SPEC-21 business profiles', () => {
  const { personas } = SYNTHETIC_DATASET_V1;

  // 1. Likely Buyer
  const likely = personas.likely_buyer;
  assert.equal(likely.type, 'likely_buyer');
  assert.equal(likely.expectedPropensityBand, 'high');
  assert.ok(likely.expectedPropensityScore !== null && likely.expectedPropensityScore >= 0.75);
  assert.ok(likely.identityTransition, 'Likely buyer must demonstrate anonymous-known transition');
  assert.ok(likely.traits.some((t) => t.key === 'intent_score' && Number(t.value) > 80));

  // 2. Non-Buyer
  const nonBuyer = personas.non_buyer;
  assert.equal(nonBuyer.type, 'non_buyer');
  assert.equal(nonBuyer.expectedPropensityBand, 'low');
  assert.ok(nonBuyer.expectedPropensityScore !== null && nonBuyer.expectedPropensityScore < 0.3);
  assert.ok(nonBuyer.traits.some((t) => t.key === 'bounce_count'));

  // 3. Repeat Buyer
  const repeat = personas.repeat_buyer;
  assert.equal(repeat.type, 'repeat_buyer');
  assert.equal(repeat.expectedPropensityBand, 'high');
  assert.ok(Array.isArray(repeat.orders) && repeat.orders.length >= 3, 'Repeat buyer must have 3+ historical orders');
  assert.ok(repeat.traits.some((t) => t.key === 'vip_tier' && t.value === 'gold'));

  // 4. Subscription Upgrade Candidate
  const upgrade = personas.subscription_upgrade_candidate;
  assert.equal(upgrade.type, 'subscription_upgrade_candidate');
  assert.equal(upgrade.expectedPropensityBand, 'high');
  assert.ok(Array.isArray(upgrade.subscriptions) && upgrade.subscriptions.some((s) => s.status === 'active'));
  assert.ok(upgrade.traits.some((t) => t.key === 'seat_usage_pct' && Number(t.value) > 90));

  // 5. Churn-like History
  const churn = personas.churn_like_history;
  assert.equal(churn.type, 'churn_like_history');
  assert.equal(churn.expectedPropensityBand, 'low');
  assert.ok(churn.traits.some((t) => t.key === 'days_since_last_seen' && Number(t.value) >= 60));
  assert.ok(churn.traits.some((t) => t.key === 'nps_score' && Number(t.value) <= 6));

  // 6. Insufficient History
  const insufficient = personas.insufficient_history;
  assert.equal(insufficient.type, 'insufficient_history');
  assert.equal(insufficient.expectedPropensityBand, 'unscored');
  assert.equal(insufficient.expectedPropensityScore, null);
  assert.ok(insufficient.engagementEvents && insufficient.engagementEvents.length === 1);
});

test('DEMO DATA: zero real PII and zero secrets in dataset', () => {
  const dataset = getSyntheticDatasetV1();

  // Zero secrets audit
  assertNoSecrets(dataset);

  // Zero real PII audit: all emails must be @example.invalid (RFC 2606)
  for (const [key, persona] of Object.entries(dataset.personas)) {
    assert.ok(
      persona.customer.email.endsWith('@example.invalid'),
      `Persona ${key} must use safe RFC 2606 domain @example.invalid, got: ${persona.customer.email}`,
    );
    if (persona.customer.phone) {
      assert.match(
        persona.customer.phone,
        /^\+551199999\d{4}$/,
        `Persona ${key} phone must be synthetic test format, got: ${persona.customer.phone}`,
      );
    }
  }
});

test('DEMO SERVICE: registers fake provider in Nest-provided ConnectorRegistryService', () => {
  const registry = new ConnectorRegistryService();
  assert.equal(registry.getDestinationAdapter(FAKE_PROVIDER), undefined);

  const service = new QaDemoWorkspaceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    registry,
  );
  service.onModuleInit();
  assert.ok(registry.getDestinationAdapter(FAKE_PROVIDER), 'Destination adapter must be registered');
  assert.ok(registry.getSourceAdapter(FAKE_PROVIDER), 'Source adapter must be registered');
});
