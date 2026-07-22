import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeights } from './attribution-models';
import type { AttributionModel } from './attribution.constants';

const MS_DAY = 86_400_000;
const ALL: AttributionModel[] = ['last_click', 'first_click', 'linear', 'position_based', 'time_decay'];
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('caminho vazio → vetor vazio', () => {
  for (const m of ALL) assert.deepEqual(computeWeights(m, [], 100, 7), []);
});

test('1 toque → 100% de crédito em QUALQUER modelo', () => {
  for (const m of ALL) assert.deepEqual(computeWeights(m, [10], 100, 7), [1]);
});

test('last_click credita 100% ao último toque', () => {
  assert.deepEqual(computeWeights('last_click', [1, 2, 3], 10, 7), [0, 0, 1]);
});

test('first_click credita 100% ao primeiro toque', () => {
  assert.deepEqual(computeWeights('first_click', [1, 2, 3], 10, 7), [1, 0, 0]);
});

test('linear divide igualmente e soma 1', () => {
  const w = computeWeights('linear', [1, 2, 3, 4], 10, 7);
  assert.ok(w.every((x) => approx(x, 0.25)));
  assert.ok(approx(sum(w), 1));
});

test('position_based N=2 → 50/50 (não há miolo)', () => {
  assert.deepEqual(computeWeights('position_based', [1, 2], 10, 7), [0.5, 0.5]);
});

test('position_based N≥3 → 40% pontas, 20% dividido no miolo, soma 1', () => {
  const w = computeWeights('position_based', [1, 2, 3, 4], 10, 7);
  assert.ok(approx(w[0], 0.4), 'primeiro 40%');
  assert.ok(approx(w[3], 0.4), 'último 40%');
  assert.ok(approx(w[1], 0.1), 'miolo 0.2/(4-2)');
  assert.ok(approx(w[2], 0.1));
  assert.ok(approx(sum(w), 1));
});

test('time_decay: toque mais recente pesa mais e soma 1', () => {
  // 2 toques: um a 1 meia-vida da conversão (peso 0.5) e um no instante (peso 1) → 1/3, 2/3.
  const conv = 7 * MS_DAY;
  const w = computeWeights('time_decay', [0, 7 * MS_DAY], conv, 7);
  assert.ok(approx(sum(w), 1));
  assert.ok(w[1] > w[0], 'o mais recente pesa mais');
  assert.ok(approx(w[0], 1 / 3, 1e-6));
  assert.ok(approx(w[1], 2 / 3, 1e-6));
});

test('time_decay degenerado (underflow → tudo ~0) cai para last_click', () => {
  // convTs absurdamente distante → e^(-λ·dias) → 0 em todos → fallback last_click.
  const w = computeWeights('time_decay', [0, 1], 1e18, 1);
  assert.deepEqual(w, [0, 1]);
});

test('todos os modelos: pesos não-negativos e soma ≈ 1 (N grande)', () => {
  const tsList = Array.from({ length: 9 }, (_, i) => i * MS_DAY);
  const conv = 9 * MS_DAY;
  for (const m of ALL) {
    const w = computeWeights(m, tsList, conv, 5);
    assert.equal(w.length, tsList.length, `cardinalidade preservada (${m})`);
    assert.ok(w.every((x) => x >= 0), `não-negativos (${m})`);
    assert.ok(approx(sum(w), 1, 1e-9), `soma 1 (${m})`);
  }
});
