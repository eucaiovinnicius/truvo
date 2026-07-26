import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsSql, buildDropoffSql, computeFunnelMetrics } from './funnel-sql';

const steps = [
  { step_id: 's1', name: 'View', event: 'page_view', conditions: {} },
  { step_id: 's2', name: 'Cart', event: 'add_to_cart', conditions: {} },
  { step_id: 's3', name: 'Buy', event: 'purchase', conditions: {} },
] as never; // FunnelStep[] — tsx apaga tipos; forma-compatível

const window = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-31T00:00:00Z') };
const input = { workspaceId: 'ws1', steps, windowSeconds: 3600, window, filters: {} } as never;

test('buildStatsSql resolve identidade (anon→user) na leitura — fix M8', () => {
  const { sql, params } = buildStatsSql(input);
  // mapa anonymous_id→user_id + agrupamento pela chave resolvida (uk)
  assert.match(sql, /argMax\(user_id, timestamp\) AS ruid/);
  assert.match(sql, /LEFT JOIN/);
  assert.match(sql, /GROUP BY uk/);
  assert.match(sql, /windowFunnel\(3600\)/);
  // regras 1 e 11 preservadas no scan
  assert.match(sql, /is_bot = 0/);
  assert.match(sql, /workspace_id = \{ws:String\}/);
  // step-events viram params (nunca interpolados crus)
  assert.equal((params as Record<string, unknown>)['s0_evt'], 'page_view');
  assert.equal((params as Record<string, unknown>)['s2_evt'], 'purchase');
});

test('buildDropoffSql também usa a identidade resolvida', () => {
  const { sql } = buildDropoffSql({ ...(input as object), stepIndex: 2, limit: 50 } as never);
  assert.match(sql, /argMax\(user_id, timestamp\) AS ruid/);
  assert.match(sql, /level = 2/);
});

test('computeFunnelMetrics: taxas, overall e maior queda', () => {
  const m = computeFunnelMetrics(steps as never, [100, 40, 10], [30, 60], 5000);
  assert.equal(m.total_visitors, 100);
  assert.equal(m.overall_conversion_rate, 10); // 10/100
  assert.equal(m.steps[0].conversion_rate, 40); // 40/100
  assert.equal(m.steps[0].drop_off_rate, 60);
  assert.equal(m.top_drop_off_step?.step_id, 's1'); // queda 100→40 (60) > 40→10 (30)
  assert.equal(m.revenue_per_visitor, 50); // 5000/100
});
