import { createClickHouse, type ClickHouseClient } from '@truvo/db';

/**
 * Client ClickHouse memoizado (singleton de processo) do M7.
 * Toda query DEVE filtrar por workspace_id (regra 1) + is_bot = 0 (regra 11).
 * Mesmo padrão de infra do M2/M6 (helper de módulo, não provider) p/ manter o
 * AttributionService sem estado de infra injetado.
 */
let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}
