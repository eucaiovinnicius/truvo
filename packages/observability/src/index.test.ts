import assert from 'node:assert/strict'; import test from 'node:test'; import { classifyFailure, metrics, redact } from './index';
test('redacts sensitive fields', () => assert.deepEqual(redact({ token: 'x', nested: { email: 'a', safe: 1 } }), { token: '[REDACTED]', nested: { email: '[REDACTED]', safe: 1 } }));
test('classifies retryable failures', () => { assert.equal(classifyFailure({ status: 503 }).kind, 'transient'); assert.equal(classifyFailure({ status: 400 }).kind, 'permanent'); });
test('metrics expose counters', () => { metrics.reset(); metrics.increment('http_errors', { status: 500 }); assert.equal(Object.keys(metrics.snapshot().counters).length, 1); });
