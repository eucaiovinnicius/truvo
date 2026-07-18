-- ============================================================================
--  M6 — METRICS / KPI LAYER · ClickHouse DDL (OPCIONAL — aceleração)
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  O MetricsService lê a tabela raw `events` DIRETAMENTE (02-events.sql) para ter
--  correção e flexibilidade total de segmentação (qualquer coluna achatada). Esta
--  MV é uma ACELERAÇÃO OPCIONAL para as leituras NÃO segmentadas (KPIs/timeseries
--  por dia): pré-agrega os contadores nativos por (workspace_id, day).
--
--  REGRAS EMBUTIDAS:
--   · regra 1  → workspace_id é a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 11 → a MV filtra `is_bot = 0`: bots nunca contam para KPIs.
--
--  Executar depois de 02-events.sql. NÃO é pré-requisito do service (que degrada
--  para a tabela raw). NN = 07 (05/06 reservados a M5/M7).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- metrics_daily — rollup diário dos contadores nativos por workspace.
-- SummingMergeTree soma as colunas numéricas; os distintos (orders/purchasers/
-- sessions/visitors) são AggregateFunction(uniq) e mesclam como no AggregatingMergeTree
-- (usar uniqMerge na leitura). Base barata do /v1/metrics/kpis|timeseries sem segmento.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics_daily
(
    workspace_id        String,
    day                 Date,

    revenue             Float64,
    subscription_value  Float64,
    events              UInt64,
    purchases           UInt64,
    conversions         UInt64,
    leads               UInt64,

    orders              AggregateFunction(uniq, String),
    purchasers          AggregateFunction(uniq, String),
    sessions            AggregateFunction(uniq, String),
    visitors            AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, day);                             -- regra 1: workspace_id 1º

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_daily_mv TO metrics_daily AS
SELECT
    workspace_id,
    toDate(timestamp)                                                       AS day,
    sum(value)                                                              AS revenue,
    sumIf(value, event_name = 'subscription_started')                       AS subscription_value,
    count()                                                                 AS events,
    countIf(event_name = 'purchase')                                        AS purchases,
    countIf(event_name IN ('purchase','checkout_completed','subscription_started')) AS conversions,
    countIf(event_name = 'lead')                                            AS leads,
    uniqStateIf(order_id, order_id != '')                                   AS orders,
    uniqStateIf(user_id,
        event_name IN ('purchase','checkout_completed','subscription_started') AND user_id != '') AS purchasers,
    uniqStateIf(session_id, session_id != '')                               AS sessions,
    uniqState(anonymous_id)                                                 AS visitors
FROM events
WHERE is_bot = 0                                          -- regra 11
GROUP BY workspace_id, day;
-- Leitura: sum(revenue), sum(purchases), uniqMerge(orders), ...  +  GROUP BY workspace_id, day.
