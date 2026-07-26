import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hmac, safeEqual, verifyShopify, verifyStripe, verifySignature } from './signature';

const SECRET = 'whsec_test_123';
const raw = Buffer.from('{"id":123,"amount":4990}');
const base = { query: {} as Record<string, unknown> };

test('hmac() casa com node:crypto (base64/hex) e safeEqual é correto', () => {
  assert.equal(hmac(raw, SECRET, 'base64'), createHmac('sha256', SECRET).update(raw).digest('base64'));
  assert.equal(hmac(raw, SECRET, 'hex'), createHmac('sha256', SECRET).update(raw).digest('hex'));
  const s = hmac(raw, SECRET, 'base64');
  assert.ok(safeEqual(s, s));
  assert.ok(!safeEqual(s, 'tamanho-diferente'));
});

test('verifyShopify: assinatura válida passa; inválida/ausente/segredo-errado falham', () => {
  const sig = createHmac('sha256', SECRET).update(raw).digest('base64');
  assert.ok(verifyShopify({ ...base, raw, headers: { 'x-shopify-hmac-sha256': sig }, secret: SECRET }));
  assert.ok(!verifyShopify({ ...base, raw, headers: { 'x-shopify-hmac-sha256': 'AAAA' }, secret: SECRET }));
  assert.ok(!verifyShopify({ ...base, raw, headers: {}, secret: SECRET }));
  assert.ok(!verifyShopify({ ...base, raw, headers: { 'x-shopify-hmac-sha256': sig }, secret: 'wrong' }));
  // corpo adulterado → falha (HMAC é sobre os bytes crus)
  assert.ok(!verifyShopify({ ...base, raw: Buffer.from('{"id":124}'), headers: { 'x-shopify-hmac-sha256': sig }, secret: SECRET }));
});

test('verifyStripe: t=<ts>,v1=<hex>; assinatura/ts errados e header malformado falham', () => {
  const t = '1700000000';
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  assert.ok(verifyStripe({ ...base, raw, headers: { 'stripe-signature': `t=${t},v1=${v1}` }, secret: SECRET }));
  assert.ok(!verifyStripe({ ...base, raw, headers: { 'stripe-signature': `t=${t},v1=deadbeef` }, secret: SECRET }));
  // timestamp diferente muda o payload assinado → falha
  assert.ok(!verifyStripe({ ...base, raw, headers: { 'stripe-signature': `t=1700000001,v1=${v1}` }, secret: SECRET }));
  assert.ok(!verifyStripe({ ...base, raw, headers: { 'stripe-signature': 'garbage' }, secret: SECRET }));
  assert.ok(!verifyStripe({ ...base, raw, headers: {}, secret: SECRET }));
});

test('verifySignature roteia por provider (shopify)', () => {
  const sig = createHmac('sha256', SECRET).update(raw).digest('base64');
  assert.ok(verifySignature('shopify', { ...base, raw, headers: { 'x-shopify-hmac-sha256': sig }, secret: SECRET }));
  assert.ok(!verifySignature('shopify', { ...base, raw, headers: { 'x-shopify-hmac-sha256': 'nope' }, secret: SECRET }));
});
