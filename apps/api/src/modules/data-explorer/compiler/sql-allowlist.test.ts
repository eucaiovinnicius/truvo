import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGuardedSql } from './sql-allowlist';

const ok = (sql: string) => assert.equal(validateGuardedSql(sql).ok, true, `deveria PASSAR: ${sql}`);
const bad = (sql: string) => assert.equal(validateGuardedSql(sql).ok, false, `deveria REJEITAR: ${sql}`);

test('SELECT/WITH de tabelas permitidas passam', () => {
  ok('SELECT count() FROM events');
  ok('SELECT * FROM touchpoints WHERE canonical_id = 1');
  ok('WITH x AS (SELECT 1 AS n) SELECT n FROM x');
});

test('DDL/DML/controle são rejeitados', () => {
  ['DROP TABLE events', 'INSERT INTO events VALUES (1)', 'ALTER TABLE events DELETE WHERE 1',
   'TRUNCATE TABLE events', 'UPDATE events SET x=1', 'SYSTEM RELOAD', 'GRANT SELECT ON x TO y',
  ].forEach(bad);
});

test('múltiplos statements são rejeitados (anti-injeção)', () => {
  bad('SELECT 1 FROM events; DROP TABLE events');
  bad('SELECT 1 FROM events; SELECT 2 FROM events');
});

test('tabelas fora do allowlist / system / outro db são rejeitadas', () => {
  bad('SELECT * FROM system.tables');
  bad('SELECT * FROM default.users');
  bad('SELECT * FROM segredo');
});

test('funções perigosas (url/file/remote/etc) são rejeitadas', () => {
  bad("SELECT * FROM url('http://evil','CSV','x String')");
  bad("SELECT * FROM remote('h','db','t')");
  bad("SELECT file('/etc/passwd')");
});

test('não-SELECT (SHOW/DESCRIBE) e vazio são rejeitados', () => {
  bad('SHOW TABLES');
  bad('DESCRIBE events');
  bad('');
  bad('   ');
});
