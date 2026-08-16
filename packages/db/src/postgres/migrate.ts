import 'dotenv/config';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for db:migrate');
const client = postgres(url, { max: 1 });
const db = drizzle(client);
const lockId = 2780427;
const migrationsFolder = resolve(process.cwd(), 'migrations');
const baselineFile = resolve(migrationsFolder, '0000_wakeful_triathlon.sql');
const baselineSnapshotFile = resolve(migrationsFolder, 'meta', '0000_snapshot.json');

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number | boolean;
}

interface SnapshotIndex {
  name: string;
  columns: Array<{ expression: string }>;
  isUnique: boolean;
  method: string;
}

interface SnapshotForeignKey {
  name: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete: string;
  onUpdate: string;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
  uniqueConstraints: Record<string, { name: string; columns: string[] }>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
}

function normalizeType(type: string): string {
  return type.toLowerCase().replace(/^character varying/, 'varchar').replace(/\s+/g, ' ').trim();
}

function normalizeDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value)
    .replace(/^\((.*)\)$/s, '$1')
    .replace(/::(?:text|character varying|[a-z_][a-z0-9_]*_status|[a-z_][a-z0-9_]*_type|[a-z_][a-z0-9_]*_platform|workspace_role|workspace_member_status|funnel_status|insight_kind|profile_access_action)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const jsonb = normalized.match(/^'(.*)'::jsonb$/s);
  if (jsonb) {
    try {
      return `${JSON.stringify(JSON.parse(jsonb[1]!.replace(/''/g, "'")))}::jsonb`;
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function sameList(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(element: string, expected: unknown, actual: unknown): never {
  throw new Error(`Existing database does not match audited v3.2 baseline at ${element}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function verifyBaseline(): Promise<void> {
  const snapshot = JSON.parse(await readFile(baselineSnapshotFile, 'utf8')) as Snapshot;
  const expectedTables = Object.values(snapshot.tables).sort((a, b) => a.name.localeCompare(b.name));
  if (!expectedTables.length) throw new Error('Committed Drizzle baseline snapshot has no tables.');

  const columns = await client<Array<{ table_name: string; column_name: string; formatted_type: string; not_null: boolean; default_value: string | null }>>`
    select c.relname as table_name, a.attname as column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type,
           a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default_value
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;
  const actualTables = [...new Set(columns.map((row) => row.table_name))].sort();
  const expectedTableNames = expectedTables.map((table) => table.name).sort();
  if (!sameList(expectedTableNames, actualTables)) fail('tables', expectedTableNames, actualTables);

  const primaryKeys = await client<Array<{ table_name: string; constraint_name: string; columns: string[] }>>`
    select tbl.relname as table_name, con.conname as constraint_name,
           array_agg(att.attname order by keys.ordinality)::text[] as columns
    from pg_constraint con
    join pg_class tbl on tbl.oid = con.conrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    join lateral unnest(con.conkey) with ordinality keys(attnum, ordinality) on true
    join pg_attribute att on att.attrelid = tbl.oid and att.attnum = keys.attnum
    where ns.nspname = 'public' and con.contype = 'p'
    group by tbl.relname, con.conname`;
  const foreignKeys = await client<Array<{ table_name: string; constraint_name: string; table_to: string; columns_from: string[]; columns_to: string[]; on_delete: string; on_update: string }>>`
    select src.relname as table_name, con.conname as constraint_name, dst.relname as table_to,
           array_agg(sa.attname order by sk.ordinality)::text[] as columns_from,
           array_agg(da.attname order by sk.ordinality)::text[] as columns_to,
           case con.confdeltype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default' end as on_delete,
           case con.confupdtype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default' end as on_update
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class dst on dst.oid = con.confrelid
    join pg_namespace ns on ns.oid = src.relnamespace
    join lateral unnest(con.conkey) with ordinality sk(attnum, ordinality) on true
    join lateral unnest(con.confkey) with ordinality dk(attnum, ordinality) on dk.ordinality = sk.ordinality
    join pg_attribute sa on sa.attrelid = src.oid and sa.attnum = sk.attnum
    join pg_attribute da on da.attrelid = dst.oid and da.attnum = dk.attnum
    where ns.nspname = 'public' and con.contype = 'f'
    group by src.relname, con.conname, dst.relname, con.confdeltype, con.confupdtype`;
  const uniqueConstraints = await client<Array<{ table_name: string; constraint_name: string; columns: string[] }>>`
    select tbl.relname as table_name, con.conname as constraint_name,
           array_agg(att.attname order by keys.ordinality)::text[] as columns
    from pg_constraint con
    join pg_class tbl on tbl.oid = con.conrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    join lateral unnest(con.conkey) with ordinality keys(attnum, ordinality) on true
    join pg_attribute att on att.attrelid = tbl.oid and att.attnum = keys.attnum
    where ns.nspname = 'public' and con.contype = 'u'
    group by tbl.relname, con.conname`;
  const indexes = await client<Array<{ table_name: string; index_name: string; is_unique: boolean; method: string; columns: string[] }>>`
    select tbl.relname as table_name, idx.relname as index_name, ind.indisunique as is_unique,
           am.amname as method,
           array(select pg_get_indexdef(ind.indexrelid, n, true) from generate_series(1, ind.indnkeyatts) n)::text[] as columns
    from pg_index ind
    join pg_class tbl on tbl.oid = ind.indrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    join pg_class idx on idx.oid = ind.indexrelid
    join pg_am am on am.oid = idx.relam
    where ns.nspname = 'public' and not ind.indisprimary
      and not exists (select 1 from pg_constraint con where con.conindid = ind.indexrelid)`;

  for (const table of expectedTables) {
    const actualColumns = columns.filter((row) => row.table_name === table.name);
    const expectedColumnNames = Object.keys(table.columns).sort();
    const actualColumnNames = actualColumns.map((row) => row.column_name).sort();
    if (!sameList(expectedColumnNames, actualColumnNames)) fail(`${table.name}.columns`, expectedColumnNames, actualColumnNames);
    for (const column of Object.values(table.columns)) {
      const actual = actualColumns.find((row) => row.column_name === column.name)!;
      if (normalizeType(column.type) !== normalizeType(actual.formatted_type)) fail(`${table.name}.${column.name}.type`, column.type, actual.formatted_type);
      if (column.notNull !== actual.not_null) fail(`${table.name}.${column.name}.notNull`, column.notNull, actual.not_null);
      if (normalizeDefault(column.default) !== normalizeDefault(actual.default_value)) fail(`${table.name}.${column.name}.default`, normalizeDefault(column.default), normalizeDefault(actual.default_value));
    }

    const expectedPk = Object.values(table.compositePrimaryKeys)[0]?.columns ?? Object.values(table.columns).filter((column) => column.primaryKey).map((column) => column.name);
    const actualPk = primaryKeys.find((key) => key.table_name === table.name)?.columns ?? [];
    if (!sameList(expectedPk, actualPk)) fail(`${table.name}.primaryKey`, expectedPk, actualPk);

    const expectedFks = Object.values(table.foreignKeys).sort((a, b) => a.name.localeCompare(b.name));
    const actualFks = foreignKeys.filter((key) => key.table_name === table.name).sort((a, b) => a.constraint_name.localeCompare(b.constraint_name));
    if (expectedFks.length !== actualFks.length) fail(`${table.name}.foreignKeys.count`, expectedFks.length, actualFks.length);
    expectedFks.forEach((expected, index) => {
      const actual = actualFks[index]!;
      const left = [expected.name, expected.tableTo, expected.columnsFrom, expected.columnsTo, expected.onDelete, expected.onUpdate];
      const right = [actual.constraint_name, actual.table_to, actual.columns_from, actual.columns_to, actual.on_delete, actual.on_update];
      if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${table.name}.foreignKey.${expected.name}`, left, right);
    });

    const expectedUniques = Object.values(table.uniqueConstraints).sort((a, b) => a.name.localeCompare(b.name));
    const actualUniques = uniqueConstraints.filter((constraint) => constraint.table_name === table.name).sort((a, b) => a.constraint_name.localeCompare(b.constraint_name));
    const expectedUniqueShape = expectedUniques.map((constraint) => [constraint.name, constraint.columns]);
    const actualUniqueShape = actualUniques.map((constraint) => [constraint.constraint_name, constraint.columns]);
    if (JSON.stringify(expectedUniqueShape) !== JSON.stringify(actualUniqueShape)) fail(`${table.name}.uniqueConstraints`, expectedUniqueShape, actualUniqueShape);

    const expectedIndexes = Object.values(table.indexes).sort((a, b) => a.name.localeCompare(b.name));
    const actualIndexes = indexes.filter((index) => index.table_name === table.name).sort((a, b) => a.index_name.localeCompare(b.index_name));
    if (expectedIndexes.length !== actualIndexes.length) fail(`${table.name}.indexes.count`, expectedIndexes.length, actualIndexes.length);
    expectedIndexes.forEach((expected, index) => {
      const actual = actualIndexes[index]!;
      const left = [expected.name, expected.isUnique, expected.method, expected.columns.map((column) => column.expression)];
      const right = [actual.index_name, actual.is_unique, actual.method, actual.columns];
      if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${table.name}.index.${expected.name}`, left, right);
    });
  }
}

async function main() {
  await client`select pg_advisory_lock(${lockId})`;
  try {
    if (process.argv.includes('--adopt-baseline')) {
      await verifyBaseline();
      const body = await readFile(baselineFile, 'utf8');
      const hash = createHash('sha256').update(body).digest('hex');
      await client`create schema if not exists drizzle`;
      await client`create table if not exists drizzle."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`;
      const existing = await client<{ hash: string }[]>`select hash from drizzle."__drizzle_migrations" where created_at = ${1786862686736}`;
      if (existing[0] && existing[0].hash !== hash) throw new Error('Drizzle baseline history hash does not match the committed migration.');
      if (!existing[0]) await client`insert into drizzle."__drizzle_migrations" (hash, created_at) values (${hash}, ${1786862686736})`;
      console.log('Audited v3.2 baseline adopted without schema changes.');
    }
    await migrate(db, { migrationsFolder });
    console.log('Postgres migrations are current.');
  } finally {
    await client`select pg_advisory_unlock(${lockId})`;
    await client.end();
  }
}
void main();
