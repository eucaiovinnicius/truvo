import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAllowsFeature, canAccessFeature, featuresForPlan } from './feature-gates';

test('starter tem explorer_visual mas NÃO explorer_sql/ai_journey', () => {
  assert.equal(planAllowsFeature('starter', 'explorer_visual'), true);
  assert.equal(planAllowsFeature('starter', 'explorer_sql'), false);
  assert.equal(planAllowsFeature('starter', 'ai_journey'), false);
});

test('agency: sentinela ALL libera as features premium na dimensão de plano', () => {
  assert.equal(planAllowsFeature('agency', 'explorer_sql'), true);
  assert.equal(planAllowsFeature('agency', 'ai_journey'), true);
  assert.equal(planAllowsFeature('agency', 'creative_analytics'), true);
});

test('canAccessFeature: explorer_sql exige PLANO e role owner/admin (role-gated)', () => {
  assert.equal(canAccessFeature('agency', 'explorer_sql', 'owner'), true);
  assert.equal(canAccessFeature('agency', 'explorer_sql', 'admin'), true);
  // agency mas role insuficiente → nega
  assert.equal(canAccessFeature('agency', 'explorer_sql', 'member'), false);
  assert.equal(canAccessFeature('agency', 'explorer_sql', 'viewer'), false);
  // sem role → fail-closed
  assert.equal(canAccessFeature('agency', 'explorer_sql', undefined), false);
  // plano não libera → nega mesmo sendo owner
  assert.equal(canAccessFeature('starter', 'explorer_sql', 'owner'), false);
});

test('canAccessFeature: ai_journey (role-gated) idem — nega member em agency', () => {
  assert.equal(canAccessFeature('agency', 'ai_journey', 'owner'), true);
  assert.equal(canAccessFeature('agency', 'ai_journey', 'member'), false);
  assert.equal(canAccessFeature('starter', 'ai_journey', 'owner'), false);
});

test('canAccessFeature: feature NÃO role-gated não exige role', () => {
  assert.equal(canAccessFeature('starter', 'dashboard_basic'), true);
  assert.equal(canAccessFeature('starter', 'explorer_visual', 'viewer'), true);
});

test('featuresForPlan expande ALL e NUNCA vaza o sentinela "all"', () => {
  const agency = featuresForPlan('agency');
  assert.ok(agency.includes('explorer_sql'), 'agency tem explorer_sql');
  assert.ok(agency.includes('ai_journey'), 'agency tem ai_journey');
  assert.ok(!(agency as string[]).includes('all'), 'sentinela "all" não vaza na lista');
  assert.ok(!featuresForPlan('starter').includes('explorer_sql'), 'starter não tem explorer_sql');
});
