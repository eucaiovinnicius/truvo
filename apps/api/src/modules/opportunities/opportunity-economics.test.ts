import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateValue, expectedRevenue, multiplyDecimal, VALUE_POLICY } from './opportunity-economics';

test('historical-value-v1 bounds a pathological outlier and preserves exact decimal revenue', () => {
  const estimate = estimateValue([
    { value: 10, currency: 'BRL' },
    { value: 11, currency: 'BRL' },
    { value: 12, currency: 'BRL' },
    { value: 13, currency: 'BRL' },
    { value: 1_000_000, currency: 'BRL' },
  ], 'customer', '2026-08-27T00:00:00.000Z');
  assert.equal(estimate.value, '12');
  assert.equal(estimate.quality, 'high');
  assert.equal(expectedRevenue('0.80', { ...estimate, value: '125.00' }), '100');
  assert.equal(multiplyDecimal('0.333333', '10.01'), '3.33666333');
  assert.equal(VALUE_POLICY.lookbackDays, 365);
});

test('economics never pools currencies or invents missing/refund value', () => {
  assert.equal(estimateValue([
    { value: 10, currency: 'BRL' },
    { value: 11, currency: 'USD' },
    { value: 12, currency: 'BRL' },
  ], 'customer').source, 'unavailable');
  const unavailable = estimateValue([
    { value: 0, currency: 'BRL' },
    { value: -1, currency: 'BRL' },
    { value: 99, currency: 'BRL', isRefundOrReversal: true },
    { value: Number.NaN, currency: 'BRL' },
    { value: 10, currency: '' },
  ], 'customer');
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.reason, 'insufficient_monetary_history');
  assert.equal(expectedRevenue('0.7', unavailable), null);
});

test('quality is deterministic for customer and cohort fallback sample sizes', () => {
  const customer = estimateValue([10, 11, 12].map((value) => ({ value, currency: 'BRL' })), 'customer');
  assert.equal(customer.quality, 'medium');
  const cohort = estimateValue(Array.from({ length: 30 }, (_, index) => ({ value: 100 + index, currency: 'BRL' })), 'cohort');
  assert.equal(cohort.quality, 'low');
  assert.equal(cohort.sampleCount, 30);
});

test('corrupt probability is rejected and never clamped', () => {
  const estimate = estimateValue([10, 11, 12].map((value) => ({ value, currency: 'BRL' })), 'customer');
  assert.throws(() => expectedRevenue('-0.01', estimate), /invalid_probability/);
  assert.throws(() => expectedRevenue('1.01', estimate), /invalid_probability/);
});
