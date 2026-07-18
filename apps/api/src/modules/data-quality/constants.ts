/**
 * Constantes do M14 — Qualidade de Dados & Reconciliação.
 */

/**
 * Eventos que contam como "receita/pedido" para reconciliar com o gateway.
 * Mantido ALINHADO com o que os normalizadores do M4 emitem (orders/paid →
 * `purchase`, assinatura → `subscription_started`) e com as conversões do
 * sessions_mv/daily_stats_mv. É a MESMA lista usada nos dois lados (Truvo no
 * ClickHouse e gateway em webhook_logs) para a comparação ser simétrica.
 */
export const REVENUE_EVENTS = [
  'purchase',
  'checkout_completed',
  'subscription_started',
] as const;

/** Evento que ABATE receita (estorno). Subtraído dos dois lados. */
export const REFUND_EVENT = 'refund';

/** Default global do limiar de `reconciliation_gap` (regra 12 / PRD §10: 2%). */
export const DEFAULT_RECONCILIATION_GAP_THRESHOLD = 0.02;

/** Janela default (dias) quando o cliente não passa start/end. */
export const DEFAULT_RANGE_DAYS = 30;

/** Nome da tabela ClickHouse de reconciliação (ver ddl/06-reconciliation.sql). */
export const CH_RECONCILIATION_TABLE = 'reconciliation_daily';
