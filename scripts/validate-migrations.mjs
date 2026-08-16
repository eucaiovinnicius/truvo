import { access, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ddlDirectory = resolve('packages/db/src/clickhouse/ddl');
const entries = (await readdir(ddlDirectory)).filter((file) => file.endsWith('.sql')).sort();
const duplicates = entries.filter((file, index) => entries.indexOf(file) !== index);
const invalid = entries.filter((file) => !/^\d{2}-[a-z0-9-]+\.sql$/.test(file));

if (duplicates.length || invalid.length) {
  console.error(`Migration validation failed. Duplicates: ${duplicates.join(', ') || 'none'}; invalid names: ${invalid.join(', ') || 'none'}`);
  process.exit(1);
}

console.log(`Migration validation passed: ${entries.length} ClickHouse DDL file(s), ordered and uniquely named.`);
const pgDirectory = resolve('packages/db/migrations');
const pgEntries = (await readdir(pgDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
if (!pgEntries.length) throw new Error('No versioned Postgres migration found.');
for (const file of pgEntries) if (!(await readFile(resolve(pgDirectory, file), 'utf8')).trim()) throw new Error(`Empty Postgres migration: ${file}`);
const journal = JSON.parse(await readFile(resolve(pgDirectory, 'meta', '_journal.json'), 'utf8'));
if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries)) throw new Error('Invalid Postgres migration journal.');
if (journal.entries.length !== pgEntries.length) throw new Error(`Postgres journal/SQL count mismatch: ${journal.entries.length}/${pgEntries.length}.`);
let priorTimestamp = -1;
for (const [position, entry] of journal.entries.entries()) {
  if (entry.idx !== position || !Number.isSafeInteger(entry.when) || entry.when <= priorTimestamp) throw new Error(`Invalid Postgres journal ordering at index ${position}.`);
  priorTimestamp = entry.when;
  const sqlFile = `${entry.tag}.sql`;
  if (pgEntries[position] !== sqlFile) throw new Error(`Postgres journal mismatch at index ${position}: expected ${pgEntries[position]}, got ${sqlFile}.`);
  const snapshotFile = resolve(pgDirectory, 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`);
  await access(snapshotFile);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  if (snapshot.dialect !== 'postgresql' || !snapshot.tables || Object.keys(snapshot.tables).length === 0) throw new Error(`Invalid Postgres snapshot for ${entry.tag}.`);
}
console.log(`Postgres migration validation passed: ${pgEntries.length} versioned SQL artifact(s).`);
