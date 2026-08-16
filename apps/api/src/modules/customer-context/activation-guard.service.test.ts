import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationGuardService, CONSENT_TRAIT_NAMESPACE } from './activation-guard.service';
import type { CustomerContextService } from './customer-context.service';

function fakeContext(getTraitResult: unknown, capture?: { upsert?: unknown }) {
  return {
    getTrait: async () => getTraitResult,
    upsertTrait: async (input: unknown) => {
      if (capture) capture.upsert = input;
      return { accepted: true, current: input };
    },
  } as unknown as CustomerContextService;
}

test('assertChannelAllowed: no recorded signal → allowed (no default-deny here by design)', async () => {
  const guard = new ActivationGuardService(fakeContext(null));
  const check = await guard.assertChannelAllowed('ws_1', 'cus_1', 'email');
  assert.equal(check.allowed, true);
  assert.equal(check.reason, undefined);
});

test('assertChannelAllowed: explicit granted=true trait → allowed', async () => {
  const guard = new ActivationGuardService(fakeContext({ value: true, observedAt: new Date() }));
  const check = await guard.assertChannelAllowed('ws_1', 'cus_1', 'email');
  assert.equal(check.allowed, true);
});

test('assertChannelAllowed: known opt-out (granted=false) → fails closed with reason + timestamp', async () => {
  const observedAt = new Date('2026-01-05T10:00:00Z');
  const guard = new ActivationGuardService(fakeContext({ value: false, observedAt }));
  const check = await guard.assertChannelAllowed('ws_1', 'cus_1', 'SMS');
  assert.equal(check.allowed, false);
  assert.match(check.reason ?? '', /opt-out/);
  assert.match(check.reason ?? '', /sms/); // channel normalized lowercase
  assert.equal(check.optOutObservedAt, observedAt);
});

test('assertChannelAllowed rejects an empty channel', async () => {
  const guard = new ActivationGuardService(fakeContext(null));
  await assert.rejects(guard.assertChannelAllowed('ws_1', 'cus_1', '   '));
});

test('recordConsent writes a boolean trait under the consent namespace', async () => {
  const capture: { upsert?: unknown } = {};
  const guard = new ActivationGuardService(fakeContext(null, capture));
  const observedAt = new Date('2026-02-01T00:00:00Z');

  await guard.recordConsent({
    workspaceId: 'ws_1',
    customerId: 'cus_1',
    channel: 'Email-Marketing',
    granted: false,
    sourceNamespace: 'consent-center',
    observedAt,
  });

  const write = capture.upsert as Record<string, unknown>;
  assert.equal(write.type, 'boolean');
  assert.equal(write.value, false);
  assert.equal(write.traitNamespace, CONSENT_TRAIT_NAMESPACE);
  assert.equal(write.traitKey, 'email-marketing');
  assert.equal(write.sourceNamespace, 'consent-center');
  assert.equal(write.observedAt, observedAt);
});
