import test from 'node:test'; import assert from 'node:assert/strict'; import { band } from './opportunities.service';
test('Opportunity v1 score bands preserve probability boundaries',()=>{assert.equal(band(.749999),'medium');assert.equal(band(.75),'high');assert.equal(band(.5),'medium');assert.equal(band(.499999),'low');assert.equal(band(0),'low');assert.equal(band(1),'high');});
