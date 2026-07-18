import { createClickHouse, type ClickHouseClient } from '@truvo/db';
import { DATE_PRESETS } from './compiler/catalog';

/**
 * M16 — infra do Data Explorer (helpers de módulo, sem estado injetado — mesmo
 * padrão do M6/M14). Toda leitura DEVE filtrar workspace_id (regra 1) + is_bot = 0
 * (regra 11); o compilador injeta ambos (regra 19).
 *
 * Reusa `createClickHouse()` do @truvo/db (mesmo client dos outros módulos) — NÃO
 * importa `@clickhouse/client` direto (não é dep do @truvo/api; contrato de arquivos).
 */

let _ch: ClickHouseClient | undefined;
function client(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}

/**
 * Client de LEITURA do modelo visual. O SQL é gerado pelo compilador (parametrizado,
 * com workspace_id injetado), então roda com o client padrão do serviço.
 *
 * // TODO(live): apontar p/ um POOL DE LEITURA dedicado (réplica) separado da
 * ingestão — uma query pesada do explorador não pode degradar a escrita de eventos
 * nem os dashboards nativos. Requer uma factory de client com CLICKHOUSE_READ_URL
 * exposta pelo @truvo/db (infra), pois o @truvo/api não importa @clickhouse/client.
 */
export function getReadClient(): ClickHouseClient {
  return client();
}

/**
 * Client de ESCRITA da trilha de auditoria (`explorer_query_log`). Insert é sempre
 * best-effort. Reusa o mesmo client (o cluster de escrita); // TODO(live): separar
 * do pool de leitura quando a réplica dedicada existir.
 */
export function getLogClient(): ClickHouseClient {
  return client();
}

/**
 * Client do SANDBOX de SQL guardado (usuário read-only `truvo_explorer` +
 * ROW POLICY + QUOTA no pool de leitura). É INFRA — // TODO(live): provisionar o
 * usuário/policy/quota/views (08-explorer.sql) e expor uma factory dedicada no
 * @truvo/db (com EXPLORER_CH_URL/USER/PASSWORD). Enquanto não existir, retorna
 * undefined e o ExplorerService recusa a execução de SQL (FAIL-CLOSED) — o SQL do
 * cliente NUNCA cai no client de escrita/ingestão.
 */
export function getSandboxClient(): ClickHouseClient | undefined {
  // Fail-closed até a infra do sandbox estar provisionada.
  return undefined;
}

// ─────────────────────────── resolução de janela ───────────────────────────

export interface ResolvedWindow {
  start: Date;
  end: Date;
}

/**
 * Resolve a janela [start,end) a partir do `date_range` do spec:
 *  · { from, to } ISO explícito;
 *  · { preset } relativo (DATE_PRESETS → dias);
 *  · ausente → últimos `defaultDays` dias.
 *
 * // TODO(live): resolver presets no TIMEZONE do workspace (M1), não em UTC — hoje
 * usa UTC. `this_month`/`last_month` são aproximados por janelas de dias.
 */
export function resolveDateRange(
  dateRange: { preset: string } | { from: string; to: string } | undefined,
  defaultDays = 30,
): ResolvedWindow {
  if (dateRange && 'from' in dateRange) {
    return { start: new Date(dateRange.from), end: new Date(dateRange.to) };
  }
  const end = new Date();
  const days = dateRange && 'preset' in dateRange ? DATE_PRESETS[dateRange.preset] : undefined;
  const span = typeof days === 'number' ? days : defaultDays;
  return { start: new Date(end.getTime() - span * 86_400_000), end };
}
