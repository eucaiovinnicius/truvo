-- ============================================================================
--  M14 — QUALIDADE DE DADOS & RECONCILIAÇÃO · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 11 → `is_bot` fica na tabela raw `events`; as MVs analíticas filtram
--                `is_bot = 0`. A ÚNICA exceção intencional é `bot_stats_daily_mv`,
--                cuja razão de existir é justamente CONTAR os bots (bot-report).
--   · regra 12 → `reconciliation_daily` é a fonte da "marca de incerteza": quando o
--                `reconciliation_gap` do período > limiar, o dado NÃO é confiável e
--                M15/M16/M17 sinalizam incerteza lendo desta tabela.
--
--  Executar em ordem: 06-reconciliation.sql roda depois de 02-events.sql (as MVs
--  aqui leem da tabela `events` criada lá).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- reconciliation_daily — totais Truvo vs gateway por (workspace_id, dia).
--
-- ENGINE = ReplacingMergeTree(_version): o serviço de reconciliação RECOMPUTA a
-- linha do dia (Truvo do ClickHouse × gateway do Postgres/webhook_logs) e reinsere;
-- a versão mais nova (maior `_version`) vence e colapsa a anterior. Um
-- SummingMergeTree estaria ERRADO aqui porque `reconciliation_gap` é uma razão —
-- somar linhas do mesmo dia produziria gap sem sentido. Recompute-and-replace é o
-- modelo correto para uma métrica derivada idempotente por (workspace_id, day).
--
-- `status`:  'reconciled'       gap <= limiar
--            'uncertain'        gap  > limiar          (regra 12)
--            'no_ground_truth'  sem receita de gateway (nenhuma integração/pedido)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_daily
(
    workspace_id        String,
    day                 Date,

    truvo_revenue       Float64 DEFAULT 0,
    truvo_orders        UInt64  DEFAULT 0,
    gateway_revenue     Float64 DEFAULT 0,
    gateway_orders      UInt64  DEFAULT 0,

    -- |truvo_revenue - gateway_revenue| / gateway_revenue  (0 quando sem ground truth)
    reconciliation_gap  Float64 DEFAULT 0,

    status              LowCardinality(String) DEFAULT 'reconciled',
    threshold           Float64 DEFAULT 0.02,

    computed_at         DateTime64(3, 'UTC') DEFAULT now64(3),
    -- versão p/ ReplacingMergeTree (ms do recompute): a reinserção mais nova vence.
    _version            UInt64 DEFAULT toUnixTimestamp64Milli(now64(3))
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, day);                            -- regra 1: workspace_id 1º
-- Leitura: `SELECT ... FROM reconciliation_daily FINAL WHERE workspace_id = {ws}`
-- (FINAL colapsa versões; range por workspace/dia é pequeno).


-- ---------------------------------------------------------------------------
-- bot_stats_daily — contagem humano/bot por (workspace_id, dia, source).
-- Base barata do /v1/data-quality/bot-report.
--
-- ATENÇÃO (regra 11): esta MV é a ÚNICA que NÃO filtra `is_bot = 0`, de propósito —
-- o produto precisa REPORTAR quantos bots foram detectados. Nenhum consumidor de
-- KPI/funil/attribution/billing deve ler daqui como se fossem eventos válidos;
-- `human_events` é a coluna a usar quando se quer "tráfego real".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_stats_daily
(
    workspace_id    String,
    day             Date,
    source          LowCardinality(String),

    total_events    UInt64,
    bot_events      UInt64,
    human_events    UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, day, source);                    -- regra 1: workspace_id 1º

CREATE MATERIALIZED VIEW IF NOT EXISTS bot_stats_daily_mv TO bot_stats_daily AS
SELECT
    workspace_id,
    toDate(timestamp)          AS day,
    source,
    count()                    AS total_events,
    countIf(is_bot = 1)        AS bot_events,
    countIf(is_bot = 0)        AS human_events
FROM events
GROUP BY workspace_id, day, source;
-- Leitura:  sum(total_events), sum(bot_events), sum(human_events)  +  GROUP BY workspace_id, day.
