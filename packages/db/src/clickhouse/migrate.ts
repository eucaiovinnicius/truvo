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
 * Best-effort: separa statements por ';' em fim de linha e ignora linhas '--'.
 * Mantenha 1 statement por bloco terminado com ';'.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ddlDir = join(here, 'ddl');

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
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
