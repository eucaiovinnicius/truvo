import { createClickHouse, type ClickHouseClient } from '@truvo/db';

/**
 * Client ClickHouse memoizado (singleton de processo) do M10.
 * Toda leitura do lado REAL filtra workspace_id (regra 1) e sai da MV que já
 * exclui bots (is_bot = 0, regra 11). Mesmo padrão de infra do M7 (helper de
 * módulo, não provider) — mantém os services e os providers de DI (AD_SPEND /
 * PLATFORM_METRICS) sem estado de infra injetado.
 */
let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}
