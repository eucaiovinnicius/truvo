import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, decodeCursor, encodeCursor, normalizeQuery, queryHash } from './opportunity-contracts';

test('compound cursor is opaque, signed and carries full query scope', () => {
  const query = normalizeQuery({ sort: 'probability', direction: 'desc', filters: { scoreBands: ['high'] } });
  const cursor = encodeCursor({
    v: 1, workspaceId: 'workspace-a', radarId: 'radar-a', batchId: 'batch-a',
    sort: 'probability', direction: 'desc', sortValue: '0.8', secondaryValue: null,
    id: 'row-a', queryHash: queryHash(query),
  });
  assert.doesNotMatch(cursor, /workspace-a/);
  assert.equal(decodeCursor(cursor).batchId, 'batch-a');
  assert.throws(() => decodeCursor(`${cursor.slice(0, -1)}x`), /invalid_cursor/);
});

test('query normalization allowlists sorts, bounds filters and normalizes currency', () => {
  const normalized = normalizeQuery({ filters: { currency: 'brl', probabilityMin: 0.5, trait: { namespace: 'canonical', key: 'country', value: 'BR' } } });
  assert.equal(normalized.filters.currency, 'BRL');
  assert.throws(() => normalizeQuery({ sort: 'raw_sql' as never }), /invalid_sort/);
  assert.throws(() => normalizeQuery({ filters: { probabilityMax: 2 } }), /invalid_probability_filter/);
  assert.throws(() => normalizeQuery({ filters: { trait: { namespace: 'x', key: 'a->b', value: 'x' } } }), /invalid_trait_filter/);
});

test('CSV string cells are formula-safe while typed negative numbers stay numeric', () => {
  for (const dangerous of ['=HYPERLINK("x")', '+cmd', '-1+2', '@SUM(A1:A2)']) assert.ok(csvCell(dangerous).includes("'"));
  assert.equal(csvCell('-12.50', true), '-12.50');
  assert.equal(csvCell('Olá, "mundo"\r\nlinha'), '"Olá, ""mundo""\r\nlinha"');
});
