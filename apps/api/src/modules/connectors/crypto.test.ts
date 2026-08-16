import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptJson, encryptJson } from './crypto';

process.env.INTEGRATIONS_ENCRYPTION_KEY ??= 'order050_crypto_test_key_dev_only';

test('encryptJson/decryptJson round-trips arbitrary JSON', () => {
  const secret = { api_key: 'sk_live_abc123', nested: { n: 1, ok: true } };
  const blob = encryptJson(secret);
  assert.match(blob, /^v1\./);
  assert.deepEqual(decryptJson(blob), secret);
});

test('decryptJson rejects a malformed blob', () => {
  assert.throws(() => decryptJson('not-a-valid-blob'));
});

test('two encryptions of the SAME plaintext produce DIFFERENT blobs (random IV — never reuse a nonce)', () => {
  const a = encryptJson({ x: 1 });
  const b = encryptJson({ x: 1 });
  assert.notEqual(a, b);
  assert.deepEqual(decryptJson(a), decryptJson(b));
});
