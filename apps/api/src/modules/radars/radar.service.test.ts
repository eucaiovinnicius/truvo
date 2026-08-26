import test from 'node:test'; import assert from 'node:assert/strict';
import { RADAR_MINIMUM_DATA_POLICY, RADAR_WINDOWS, validateAudienceAst } from './radar.service';
test('Radar v1 only accepts bounded windows and canonical audience AST', () => { assert.deepEqual(RADAR_WINDOWS, [7,14,30,60]); assert.deepEqual(validateAudienceAst({version:1,op:'identified'}), {version:1,op:'identified'}); assert.throws(() => validateAudienceAst({version:1,op:'sql'})); });
test('Radar readiness policy is centralized and configurable', () => { assert.equal(typeof RADAR_MINIMUM_DATA_POLICY.minLabeledExamples, 'number'); assert.equal(typeof RADAR_MINIMUM_DATA_POLICY.minPositives, 'number'); assert.equal(typeof RADAR_MINIMUM_DATA_POLICY.minNegatives, 'number'); });
