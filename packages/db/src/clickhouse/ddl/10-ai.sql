-- ============================================================================
--  M17 — AI JOURNEY INTELLIGENCE · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  ARQUITETURA DETERMINISTIC-FIRST (regras 12/13/17): TODO número que o LLM cita
--  vem de agregados pré-calculados no ClickHouse (o "evidence pack"). Esta tabela é
--  o backbone determinístico da análise de jornadas POR CANAL: pré-agrega, por
--  (workspace_id, dia, canal), os toques, pessoas, conversões e receita a partir de
--  `touchpoints` (05-identity.sql). O serviço lê daqui para CVR (com Wilson
--  lower-bound), receita e LTV-proxy por canal — barato e estável.
--
--  A reconstrução de SEQUÊNCIAS de jornada (path A > B > C) e o crédito multi-touch
--  continuam sendo feitos na aplicação REUSANDO o AttributionService (M7), que lê
--  `touchpoints` ordenados por pessoa. A receita RECONCILIADA e a marca de incerteza
--  vêm de `reconciliation_daily` (M14, 06-reconciliation.sql). Este arquivo cobre só
--  o agregado por canal/dia.
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 11 → a MV filtra `is_bot = 0` na origem; `journey_paths_daily` é
--                bot-free POR CONSTRUÇÃO (não carrega coluna is_bot, igual a
--                metrics_daily/reconciliation_daily). Toda leitura ainda filtra
--                workspace_id (regra 1).
--
--  Executar depois de 05-identity.sql (cria `touchpoints`). NN = 10 (não colide).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- journey_paths_daily — AggregatingMergeTree. Uma linha por
-- (workspace_id, dia, canal) com os estados de agregação:
--   · touches      = countState()                       → countMerge
--   · persons      = uniqState(canonical_id)            → uniqMerge  (alcance do canal)
--   · converters   = uniqStateIf(canonical_id, conv)    → uniqMerge  (denominador≠numerador da CVR)
--   · conversions  = uniqStateIf(order_id, conv)        → uniqMerge  (pedidos únicos)
--   · revenue      = sumStateIf(value, conv)            → sumMerge   (receita atribuída ao toque de conversão)
-- onde `conv = order_id != ''` (o toque é uma conversão).
--
-- CVR determinística por canal = uniqMerge(converters) / uniqMerge(persons); o
-- Wilson lower-bound é aplicado na aplicação (evidence pack) para não superestimar
-- canais de baixa amostra.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_paths_daily
(
    workspace_id    String,
    day             Date,
    channel         LowCardinality(String),

    touches         AggregateFunction(count),
    persons         AggregateFunction(uniq, String),
    converters      AggregateFunction(uniq, String),
    conversions     AggregateFunction(uniq, String),
    revenue         AggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, day, channel);                   -- regra 1: workspace_id 1º

-- ---------------------------------------------------------------------------
-- journey_paths_daily_mv — alimenta a tabela a partir de `touchpoints`.
-- Exclui bots (regra 11). A expressão de canal (channel_resolved) DEVE ficar em
-- sincronia com a VIEW v_attribution_touchpoints (08-attribution.sql) e com o
-- CHANNEL_RESOLVE_SQL do serviço — é um expression puro de colunas do servidor.
-- ---------------------------------------------------------------------------
-- Nota: a resolução de canal é feita num subquery e exposta como `channel_resolved`
-- (MESMO motivo do 08-attribution.sql: evitar colisão de nome com a coluna-fonte
-- `touchpoints.channel`). O SELECT externo renomeia para `channel` (nome da coluna
-- de destino) e agrega — sem ambiguidade.
CREATE MATERIALIZED VIEW IF NOT EXISTS journey_paths_daily_mv TO journey_paths_daily AS
SELECT
    workspace_id,
    day,
    channel_resolved                                               AS channel,
    countState()                                                   AS touches,
    uniqState(canonical_id)                                        AS persons,
    uniqStateIf(canonical_id, is_conversion)                       AS converters,
    uniqStateIf(order_id, is_conversion)                           AS conversions,
    sumStateIf(value, is_conversion)                               AS revenue
FROM (
    SELECT
        workspace_id,
        toDate(ts)                                                 AS day,
        canonical_id,
        order_id,
        value,
        order_id != ''                                             AS is_conversion,
        multiIf(
            channel != '',                                                  channel,
            positionCaseInsensitive(utm_medium, 'cpc')  > 0
              OR positionCaseInsensitive(utm_medium, 'ppc')  > 0
              OR positionCaseInsensitive(utm_medium, 'paid') > 0,
                multiIf(
                    utm_source IN ('facebook','instagram','fb','ig','meta','tiktok',
                                   'linkedin','twitter','x','pinterest','snapchat'),
                        'paid_social',
                    'paid_search'),
            positionCaseInsensitive(utm_medium, 'email') > 0
              OR utm_source IN ('email','newsletter'),                      'email',
            positionCaseInsensitive(utm_medium, 'social') > 0,              'organic_social',
            utm_medium = 'organic',                                         'organic',
            utm_medium = 'referral',                                        'referral',
            utm_source != '',                                              'referral',
            'direct'
        )                                                          AS channel_resolved
    FROM touchpoints
    WHERE is_bot = 0                                     -- regra 11
)
GROUP BY workspace_id, day, channel;
-- Leitura (evidence pack):
--   SELECT
--     channel,
--     countMerge(touches)    AS touches,
--     uniqMerge(persons)     AS persons,
--     uniqMerge(converters)  AS converters,
--     uniqMerge(conversions) AS conversions,
--     sumMerge(revenue)      AS revenue
--   FROM journey_paths_daily
--   WHERE workspace_id = {ws:String}                      -- regra 1
--     AND day >= {start:Date} AND day <= {end:Date}
--   GROUP BY channel;

-- ---------------------------------------------------------------------------
-- TODO(live) — QUEM POPULA:
--   Depende do CONSUMER do M2 gravar `touchpoints` e do STITCHING do M8
--   (05-identity.sql) manter `canonical_id`. Enquanto esse pipeline não estiver
--   ligado, `journey_paths_daily` fica vazia e o evidence pack retorna zeros — a
--   LEITURA já está pronta e correta. A receita RECONCILIADA e a marca de incerteza
--   vêm de `reconciliation_daily` (M14). Spend/ROAS/CAC dependem do M10
--   (AD_SPEND_PROVIDER); enquanto indisponível, ficam null (regra 12).
-- ---------------------------------------------------------------------------
