import type { ClickHouseClient } from '@truvo/db';
import type { StitchJob } from './stitch-queue';

/**
 * Stitching RETROATIVO — recomputa o estado derivado depois que um merge fundiu
 * `merged_from[]` (perdedores) no `canonical_id` (vencedor).
 *
 * ⚠️ PRD §15: é o processamento mais pesado e propenso a inconsistência do sistema.
 * Requisitos: IDEMPOTENTE (reaplicar converge) e REPROCESSÁVEL (crash → reprocessa).
 *
 * O que este passo faz HOJE:
 *   1. touchpoints (ClickHouse): reescreve `canonical_id` dos perdedores → vencedor
 *      via ALTER ... UPDATE (mutation). Reaplicar é no-op (as linhas já apontam p/ o
 *      vencedor), logo é idempotente. É o dado que o M7 (attribution) lê.
 *
 * O que fica como // TODO(live) (depende de M5/M7 materializados + infra no ar):
 *   2. Recalcular FUNIS (M5) afetados pelo canonical (drop-off por pessoa muda).
 *   3. Recalcular ATRIBUIÇÃO (M7): conversion paths do vencedor mudam ao herdar os
 *      touchpoints dos perdedores.
 *   4. Invalidar/recalcular a projeção `user_profiles` (M15) do vencedor.
 *   5. Eventos crus (`events`) NÃO são mutados por linha (bilhões de linhas): a
 *      resolução canonical p/ eventos históricos é por JOIN em identity_links na
 *      leitura. Ver notes do M8.
 */

export interface RetroStitchResult {
  workspace_id: string;
  canonical_id: string;
  losers: number;
  touchpoints_rewritten: boolean;
}

export async function runRetroStitch(ch: ClickHouseClient, job: StitchJob): Promise<RetroStitchResult> {
  const losers = job.merged_from.filter((c) => c && c !== job.canonical_id);

  for (const loser of losers) {
    // 1. touchpoints: mutation idempotente. Filtro por workspace_id (regra 1).
    await ch.command({
      query: `
        ALTER TABLE touchpoints
        UPDATE canonical_id = {winner:String}
        WHERE workspace_id = {ws:String} AND canonical_id = {loser:String}`,
      query_params: {
        winner: job.canonical_id,
        ws: job.workspace_id,
        loser,
      },
      // mutations_sync=1 → espera a mutation terminar (checkpoint honesto p/ o worker).
      // TODO(live): em prod, considerar mutations_sync=0 + acompanhamento em
      // system.mutations p/ não segurar o worker em merges de canonicals "gordos".
      clickhouse_settings: { mutations_sync: '1' },
    });
  }

  // 2..4 — TODO(live): recompute de funis/atribuição/perfil do canonical vencedor.
  //   M5 funnel recompute:  reprocessar coortes que contêm {canonical_id}.
  //   M7 attribution:        reconstruir conversion paths do {canonical_id}.
  //   M15 user_profiles:     recalcular a projeção consolidada do {canonical_id}.
  // Estruturado aqui de propósito: quando M5/M7/M15 estiverem materializados,
  // plugar as chamadas neste ponto — o job já carrega tudo que precisam.

  return {
    workspace_id: job.workspace_id,
    canonical_id: job.canonical_id,
    losers: losers.length,
    touchpoints_rewritten: losers.length > 0,
  };
}
