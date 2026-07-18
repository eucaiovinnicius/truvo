import { createClickHouse, type ClickHouseClient } from '@truvo/db';

/**
 * Client ClickHouse memoizado (singleton de processo) do M17.
 * Toda query DEVE filtrar por workspace_id (regra 1); `journey_paths_daily` já é
 * bot-free por construção (a MV do 10-ai.sql aplica is_bot = 0). Mesmo padrão de
 * infra do M7/M2 (helper de módulo, não provider).
 */
let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}
