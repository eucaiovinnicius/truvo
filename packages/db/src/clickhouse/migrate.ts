import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClickHouse } from '../clickhouse';

/**
 * Runner de DDL do ClickHouse (dev). Aplica, em ordem alfabética, todos os
 * arquivos packages/db/src/clickhouse/ddl/NN-*.sql. Requer ClickHouse no ar
 * (`pnpm infra:up`). Rodar via `pnpm --filter @truvo/db ch:migrate`.
 *
 * Best-effort: remove comentários '--' (inline e de linha) e separa statements
 * por ';'. Mantenha 1 statement por bloco terminado com ';'.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ddlDir = join(here, 'ddl');

function splitStatements(sql: string): string[] {
  // 1. Remove comentários de linha (-- até o fim da linha), inline ou não —
  //    assim um `; -- comentário` corta corretamente no `;`.
  const withoutComments = sql
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  // 2. Separa por ';' e descarta blocos vazios.
  return withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function main() {
  const client = createClickHouse();
  const files = readdirSync(ddlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[ch:migrate] nenhum .sql em', ddlDir);
    return;
  }

  for (const file of files) {
    const statements = splitStatements(readFileSync(join(ddlDir, file), 'utf8'));
    for (const query of statements) {
      await client.command({ query });
    }
    // eslint-disable-next-line no-console
    console.log(`[ch:migrate] ${file} — ${statements.length} statement(s) OK`);
  }

  await client.close();
  // eslint-disable-next-line no-console
  console.log('[ch:migrate] concluído');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ch:migrate] falhou:', err);
  process.exit(1);
});
