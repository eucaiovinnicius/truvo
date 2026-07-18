import { createClickHouse, type ClickHouseClient } from '@truvo/db';

/**
 * Client ClickHouse memoizado (singleton de processo) do M15.
 *
 * Segue o padrão de infra do M6/M8 (helper de módulo, não provider): o M15 lê
 * `events` (timeline), `touchpoints` (jornada) e `reconciliation_daily` (incerteza).
 * Postgres (projeção `user_profiles` + `profile_access_log` + identity_links do M8)
 * é injetado via o provider global DRIZZLE (AuthModule @Global) — ver ProfilesService.
 *
 * Toda query analítica DEVE filtrar por workspace_id (regra 1) + is_bot = 0 (regra 11).
 */
let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}
