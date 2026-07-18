import type { Provider } from '@nestjs/common';
import { createDb, type Database } from '@truvo/db';

/**
 * Conexão Drizzle (Postgres/Supabase) como provider injetável.
 * Exposto pelo AuthModule (@Global) para reuso pelos demais módulos.
 * Toda query DEVE filtrar por workspace_id (regra 1).
 */
export const DRIZZLE = Symbol('DRIZZLE');

export const databaseProvider: Provider = {
  provide: DRIZZLE,
  // TODO(live): exige DATABASE_URL apontando para o Postgres do Supabase.
  // createDb lança erro claro se DATABASE_URL estiver ausente (ver @truvo/db).
  useFactory: (): Database => createDb(),
};

export type { Database };
