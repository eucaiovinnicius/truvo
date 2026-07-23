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
    // `canonical_id` faz parte da ORDER BY key de `touchpoints` (05-identity.sql) e o
    // ClickHouse PROÍBE `ALTER ... UPDATE` de coluna de chave. Fazemos o re-stitch por
    // REINSERT sob o canonical vencedor (nova chave) + DELETE das linhas do perdedor.
    // Idempotente: reinserir quando já é o vencedor colapsa no ReplacingMergeTree (mesma
    // chave, versão nova vence); apagar linhas inexistentes é no-op. Reprocessável:
    // crash entre 1a e 1b → o reprocesso reinsere (dup colapsa) e apaga (converge).
    // Filtro por workspace_id em tudo (regra 1).
    // 1a. reinsere os toques do perdedor apontando para o vencedor.
    // O filtro fica numa SUBQUERY: se o `WHERE canonical_id = {loser}` ficasse no
    // mesmo nível do `'{winner}' AS canonical_id`, o ClickHouse resolveria o alias no
    // WHERE (winner == loser → sempre falso) e reinseriria ZERO linhas. Filtrar dentro
    // e projetar o canonical vencedor fora evita o sombreamento do alias.
    await ch.command({
      query: `
        INSERT INTO touchpoints
          (workspace_id, canonical_id, ts, channel, utm_source, utm_medium,
           utm_campaign, click_id, order_id, source, event_id, value, is_bot)
        SELECT
          workspace_id, {winner:String} AS canonical_id, ts, channel, utm_source,
          utm_medium, utm_campaign, click_id, order_id, source, event_id, value, is_bot
        FROM (
          SELECT * FROM touchpoints
          WHERE workspace_id = {ws:String} AND canonical_id = {loser:String}
        )`,
      query_params: { winner: job.canonical_id, ws: job.workspace_id, loser },
    });
    // 1b. apaga as linhas antigas (sob o canonical perdedor).
    // mutations_sync=1 → espera terminar (checkpoint honesto p/ o worker).
    // TODO(live): em prod, mutations_sync=0 + acompanhamento em system.mutations p/
    // não segurar o worker em merges de canonicals "gordos".
    await ch.command({
      query: `
        ALTER TABLE touchpoints
        DELETE WHERE workspace_id = {ws:String} AND canonical_id = {loser:String}`,
      query_params: { ws: job.workspace_id, loser },
      clickhouse_settings: { mutations_sync: '1' },
    });
  }

  // 2 — M7 (atribuição): NÃO é materializado — lê `touchpoints` AO VIVO. Com o passo 1
  //   re-stitchando o canonical_id, a atribuição do vencedor herda os toques do perdedor
  //   na próxima leitura. Nada a recomputar aqui.
  // 3 — M5 (funis): ATENÇÃO — os funis leem `events` agrupando pela PRÓPRIA chave de
  //   pessoa (u_<user_id>/a_<anonymous_id> em funnel-sql.ts), NÃO por canonical/touchpoints.
  //   Logo o re-stitch NÃO os corrige: após um merge, o anônimo e o identificado ainda
  //   contam como 2 pessoas no funil. // TODO(live): resolver identidade no funil (JOIN em
  //   identity_links na leitura, ou recompute por coorte) — gap SEPARADO, ainda aberto.
  // 4 — M15 (user_profiles): a projeção é LAZY (recomputa do ClickHouse por actor quando
  //   `computed_at` passa do TTL, ≤300s). Após o merge, a próxima leitura do Customer 360
  //   do vencedor recomputa sozinha. // TODO(live): invalidação PROATIVA exigiria endpoint
  //   interno (o consumer não escreve Postgres); hoje o TTL cobre a defasagem.

  return {
    workspace_id: job.workspace_id,
    canonical_id: job.canonical_id,
    losers: losers.length,
    touchpoints_rewritten: losers.length > 0,
  };
}
