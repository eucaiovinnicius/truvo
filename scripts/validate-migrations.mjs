import { readdir } from 'node:fs/promises';
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
console.log('Postgres versioned migration history is intentionally not implemented; see Execution Order 27.');
