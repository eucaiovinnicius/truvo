import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyField,
  normalizeEmailHash,
  normalizePhoneHash,
  sha256Hex,
  isSha256Hex,
  isLikelyRawPii,
} from './pii';

test('classifyField recognizes credentials, email, phone, hash and external ids', () => {
  assert.equal(classifyField('api_key'), 'credential');
  assert.equal(classifyField('Authorization'), 'credential');
  assert.equal(classifyField('stripe_secret_key'), 'credential');
  assert.equal(classifyField('email'), 'email');
  assert.equal(classifyField('billing_email'), 'email');
  assert.equal(classifyField('phone'), 'phone');
  assert.equal(classifyField('telefone'), 'phone');
  assert.equal(classifyField('email_hash'), 'email'); // email pattern wins before hash (still PII-correct)
  assert.equal(classifyField('generic_hash'), 'hash');
  assert.equal(classifyField('user_id'), 'external_id');
  assert.equal(classifyField('anonymous_id'), 'external_id');
  assert.equal(classifyField('nickname'), 'unclassified');
});

test('normalizeEmailHash trims/lowercases and hashes; passthrough for existing hash', () => {
  const hashed = normalizeEmailHash('  Ana@Loja.com ');
  assert.equal(hashed, sha256Hex('ana@loja.com'));
  const alreadyHashed = sha256Hex('x@y.com');
  assert.equal(normalizeEmailHash(alreadyHashed), alreadyHashed);
  assert.equal(normalizeEmailHash(''), undefined);
  assert.equal(normalizeEmailHash(null), undefined);
});

test('normalizePhoneHash strips non-digits before hashing; passthrough for existing hash', () => {
  const hashed = normalizePhoneHash('+55 (11) 99999-8888');
  assert.equal(hashed, sha256Hex('5511999998888'));
  const alreadyHashed = sha256Hex('5511999998888');
  assert.equal(normalizePhoneHash(alreadyHashed), alreadyHashed);
  assert.equal(normalizePhoneHash('   '), undefined);
});

test('isSha256Hex only accepts well-formed 64-hex-char strings', () => {
  assert.ok(isSha256Hex(sha256Hex('a')));
  assert.ok(!isSha256Hex('not-a-hash'));
  assert.ok(!isSha256Hex(''));
});

test('isLikelyRawPii flags plaintext email/phone but not hashes or unrelated strings', () => {
  assert.ok(isLikelyRawPii('ana@loja.com'));
  assert.ok(isLikelyRawPii('+55 11 99999-8888'));
  assert.ok(!isLikelyRawPii(sha256Hex('ana@loja.com')));
  assert.ok(!isLikelyRawPii('workspace_123'));
  assert.ok(!isLikelyRawPii(42));
  assert.ok(!isLikelyRawPii(undefined));
});
