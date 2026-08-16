import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * from './schema';
export * from './clickhouse';

/** Cria a conexão Drizzle (Postgres/Supabase). O app carrega o .env. */
export function createDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL não configurada — ver .env.example');
  }
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * Fecha o client postgres-js subjacente a um `Database` criado por `createDb()`.
 * O app de longa duração (NestJS) NUNCA chama isto — a conexão vive com o
 * processo. Necessário só para scripts/testes de vida curta (ex.: testes de
 * integração reais contra Postgres): sem fechar, o pool de conexões mantém o
 * event loop vivo e o processo nunca sai sozinho (Order 035 runtime verification
 * expôs esse defeito nos testes real-Postgres — timeout ao rodar `pnpm test`).
 * `db.session.client` é o caminho interno do driver postgres-js do drizzle-orm
 * 0.32.x (não documentado como API pública — `$client` só existe em versões
 * mais novas do drizzle-orm).
 */
export async function closeDb(db: Database, timeoutSeconds = 1): Promise<void> {
  const client = (db as unknown as { session: { client: { end: (opts?: { timeout?: number }) => Promise<void> } } })
    .session.client;
  await client.end({ timeout: timeoutSeconds });
}
