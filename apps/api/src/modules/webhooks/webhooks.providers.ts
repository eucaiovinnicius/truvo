import { createDb, type Database } from '@truvo/db';
import type { Provider } from '@nestjs/common';
import { WEBHOOKS_DB } from './constants';

/**
 * Provider da conexão Drizzle (Postgres/Supabase) para o módulo de webhooks.
 * Lê `DATABASE_URL` do ambiente (via createDb). // TODO(live): DATABASE_URL.
 *
 * NOTA: uma única conexão por processo é suficiente aqui; na integração pode
 * ser promovido a um DbModule global compartilhado entre os módulos.
 */
export const databaseProvider: Provider = {
  provide: WEBHOOKS_DB,
  useFactory: (): Database => createDb(),
};

export type { Database };
