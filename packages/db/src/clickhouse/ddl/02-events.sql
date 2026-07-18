-- ============================================================================
--  M2 — EVENT PIPELINE · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 5  → nunca persistimos `ip` bruto; só ip_country / ip_city (pós-enrich).
--   · regra 11 → `is_bot` fica na tabela raw (auditável), mas as MVs analíticas
--                filtram `is_bot = 0` — bots nunca contam para KPIs/funis/billing.
--
--  Executar em ordem: 02-events.sql roda depois do 01 (M1) se houver.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- events — tabela raw. ReplacingMergeTree por event_id (rede de segurança final
-- de idempotência; o Redis dedup 24h e o dedup por order_id vêm antes, no consumer).
--
-- Colunas de context/properties ACHATADAS (colunas dedicadas p/ query rápida) +
-- os payloads originais preservados como JSON String (`properties`,`context`,`raw`).
--
-- Dedup: `ReplacingMergeTree(_version)` colapsa linhas com a MESMA ORDER BY key,
-- mantendo o maior `_version`. Um mesmo `event_id` sempre carrega o MESMO
-- (workspace_id, event_name, timestamp) — são propriedades imutáveis do evento —
-- portanto a reprocessagem do mesmo event_id colapsa corretamente para 1 linha.
-- `_version` = instante de processamento (ms): a reinserção mais nova vence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events
(
    event_id        String,
    event_name      LowCardinality(String),
    source          LowCardinality(String),
    workspace_id    String,

    timestamp       DateTime64(3, 'UTC'),
    received_at     DateTime64(3, 'UTC'),

    anonymous_id    String DEFAULT '',
    user_id         String DEFAULT '',
    session_id      String DEFAULT '',
    click_id        String DEFAULT '',
    order_id        String DEFAULT '',

    -- context (achatado) — regra 5: SEM coluna de ip bruto
    utm_source      LowCardinality(String) DEFAULT '',
    utm_medium      LowCardinality(String) DEFAULT '',
    utm_campaign    String DEFAULT '',
    utm_content     String DEFAULT '',
    utm_term        String DEFAULT '',
    page_url        String DEFAULT '',
    referrer        String DEFAULT '',
    ip_country      LowCardinality(String) DEFAULT '',
    ip_city         String DEFAULT '',
    device_type     LowCardinality(String) DEFAULT '',
    os              LowCardinality(String) DEFAULT '',
    browser         LowCardinality(String) DEFAULT '',
    user_agent      String DEFAULT '',

    -- conversão (extraído de properties p/ agregação barata)
    value           Float64 DEFAULT 0,
    currency        LowCardinality(String) DEFAULT '',

    -- qualidade
    is_bot          UInt8 DEFAULT 0,

    -- payloads originais (JSON as string)
    properties      String DEFAULT '{}',
    context         String DEFAULT '{}',
    raw             String DEFAULT '{}',

    -- versão p/ ReplacingMergeTree (ms de processamento)
    _version        UInt64 DEFAULT toUnixTimestamp64Milli(now64(3)),

    INDEX idx_order_id order_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_user_id  user_id  TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(timestamp)                         -- retenção/TTL por mês
ORDER BY (workspace_id, event_name, timestamp, event_id) -- regra 1: workspace_id 1º
SETTINGS index_granularity = 8192;


-- ---------------------------------------------------------------------------
-- sessions — AggregatingMergeTree. Uma linha por (workspace_id, session_id):
-- janela da sessão, contagens, receita e UTM de primeiro toque (argMin no tempo).
-- Alimentada por sessions_mv, que já exclui bots (regra 11).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions
(
    workspace_id    String,
    session_date    Date,
    session_id      String,

    started_at      SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    ended_at        SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    events          SimpleAggregateFunction(sum, UInt64),
    pageviews       SimpleAggregateFunction(sum, UInt64),
    conversions     SimpleAggregateFunction(sum, UInt64),
    revenue         SimpleAggregateFunction(sum, Float64),

    anonymous_id    SimpleAggregateFunction(any, String),
    device_type     SimpleAggregateFunction(any, String),

    -- primeiro toque (menor timestamp): precisa de estado de agregação
    first_utm_source   AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    first_utm_campaign AggregateFunction(argMin, String, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(session_date)
ORDER BY (workspace_id, session_date, session_id);      -- regra 1: workspace_id 1º

CREATE MATERIALIZED VIEW IF NOT EXISTS sessions_mv TO sessions AS
SELECT
    workspace_id,
    toDate(timestamp)                                   AS session_date,
    session_id,
    min(timestamp)                                      AS started_at,
    max(timestamp)                                      AS ended_at,
    sum(1)                                              AS events,
    countIf(event_name = 'page_view')                   AS pageviews,
    countIf(event_name IN ('purchase', 'checkout_completed', 'subscription_started')) AS conversions,
    sum(value)                                          AS revenue,
    any(anonymous_id)                                   AS anonymous_id,
    any(device_type)                                    AS device_type,
    argMinState(utm_source, timestamp)                  AS first_utm_source,
    argMinState(utm_campaign, timestamp)                AS first_utm_campaign
FROM events
WHERE is_bot = 0 AND session_id != ''                   -- regra 11
GROUP BY workspace_id, session_date, session_id;
-- Leitura:  argMinMerge(first_utm_source)  +  GROUP BY workspace_id, session_id.


-- ---------------------------------------------------------------------------
-- daily_stats — SummingMergeTree. Volume/receita agregados por
-- (workspace_id, dia, event_name, source). Base barata do /v1/events/volume e
-- do contador de billing. Exclui bots (regra 11).
-- `visitors` é AggregateFunction(uniq) — o SummingMergeTree o mescla como um
-- AggregatingMergeTree faria (usar uniqMerge na leitura).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_stats
(
    workspace_id    String,
    day             Date,
    event_name      LowCardinality(String),
    source          LowCardinality(String),

    events          UInt64,
    conversions     UInt64,
    revenue         Float64,
    visitors        AggregateFunction(uniq, String)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, day, event_name, source);       -- regra 1: workspace_id 1º

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats_mv TO daily_stats AS
SELECT
    workspace_id,
    toDate(timestamp)                                   AS day,
    event_name,
    source,
    count()                                             AS events,
    countIf(event_name IN ('purchase', 'checkout_completed', 'subscription_started')) AS conversions,
    sum(value)                                          AS revenue,
    uniqState(anonymous_id)                             AS visitors
FROM events
WHERE is_bot = 0                                        -- regra 11
GROUP BY workspace_id, day, event_name, source;
-- Leitura:  sum(events), sum(revenue), uniqMerge(visitors)  +  GROUP BY workspace_id, day.
