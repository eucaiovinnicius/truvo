import { createDb, type Database } from '@truvo/db';
import type { Provider } from '@nestjs/common';
import { INTEGRATIONS_OUT_DB } from './integrations-out.constants';

/**
 * Provider da conexão Drizzle (Postgres/Supabase) do M9. Lê `DATABASE_URL` do
 * ambiente (via createDb). Mesmo padrão do M4 (webhooks.providers.ts).
 * // TODO(live): DATABASE_URL. Na integração pode virar um DbModule global.
 */
export const databaseProvider: Provider = {
  provide: INTEGRATIONS_OUT_DB,
  useFactory: (): Database => createDb(),
};

export type { Database };
