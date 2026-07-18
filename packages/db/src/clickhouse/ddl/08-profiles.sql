-- ============================================================================
--  M15 — CUSTOMER PROFILE / USER 360 · ClickHouse DDL (OPCIONAL — aceleração)
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  O M15 é uma SUPERFÍCIE DE LEITURA sobre dados que já existem:
--    · timeline de eventos → tabela raw `events` (02-events.sql)
--    · jornada de conversão → `touchpoints` (05-identity.sql, do M7/M8)
--    · métricas consolidadas → agregadas de `events`
--    · incerteza → `reconciliation_daily` (06-reconciliation.sql, do M14)
--  Ele NÃO cria uma segunda fonte de verdade — só lê e apresenta (PRD §7 M15).
--
--  Por isso o ProfilesService lê a tabela raw `events` DIRETAMENTE (correção +
--  história COMPLETA, incluindo eventos anteriores a qualquer MV). Esta MV é uma
--  ACELERAÇÃO OPCIONAL do caminho quente "timeline de UMA pessoa": a `events` está
--  ordenada por (workspace_id, event_name, timestamp, event_id), ótima para KPIs por
--  evento mas cara para varrer TODOS os eventos de um indivíduo (não há índice por
--  anonymous_id). `profile_timeline` reordena por PESSOA para tornar esse scan barato.
--  Mesmo espírito de 07-metrics.sql: NÃO é pré-requisito do service (que degrada para
--  a `events` raw).
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 5  → NENHUM ip bruto: só ip_country / ip_city (colunas achatadas de events).
--   · regra 11 → a MV filtra `is_bot = 0`: bots nunca entram na timeline do perfil.
--
--  Executar depois de 02-events.sql. NN = 08 (05/06/07 reservados a M8/M14/M6).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profile_timeline — ReplacingMergeTree por (workspace_id, actor_id, timestamp,
-- event_id). `actor_id` é a âncora de PESSOA na LINHA do evento: user_id quando
-- presente, senão anonymous_id.
--
-- >> Por que actor_id na linha (e não canonical_id)? A resolução canonical→pessoa
--    vive no Postgres (identity_links, M8) e MUDA com merges/stitch retroativo.
--    Reescrever bilhões de linhas de evento a cada merge seria proibitivo (ver nota
--    em 05-identity.sql). Então gravamos o identificador ESTÁVEL do evento (user_id
--    ou anonymous_id) e a leitura resolve o conjunto de identificadores da pessoa no
--    Postgres e consulta `actor_id IN (user_id..., anonymous_id...)`. Um identify
--    posterior não exige reescrever o histórico: os eventos anônimos continuam sob
--    seu anonymous_id e a leitura os une pelo grafo.
--
-- Idempotência: ReplacingMergeTree(_version) colapsa o mesmo `event_id` reprocessado.
-- Colunas de context são as ACHATADAS e IP-free (regra 5); os payloads `properties`/
-- `context` originais ficam como String para a expansão do evento na UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile_timeline
(
    workspace_id    String,
    actor_id        String,                                 -- user_id não-vazio, senão anonymous_id

    timestamp       DateTime64(3, 'UTC'),
    event_id        String,
    event_name      LowCardinality(String),
    source          LowCardinality(String) DEFAULT '',

    anonymous_id    String DEFAULT '',
    user_id         String DEFAULT '',
    session_id      String DEFAULT '',
    order_id        String DEFAULT '',

    -- context achatado (regra 5: SEM ip bruto)
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

    value           Float64 DEFAULT 0,
    currency        LowCardinality(String) DEFAULT '',

    -- payloads originais p/ a expansão do evento (JSON as string)
    properties      String DEFAULT '{}',
    context         String DEFAULT '{}',

    _version        UInt64 DEFAULT toUnixTimestamp64Milli(now64(3))
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(timestamp)                            -- retenção/TTL por mês
ORDER BY (workspace_id, actor_id, timestamp, event_id)      -- regra 1: workspace_id 1º; leitura por pessoa
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS profile_timeline_mv TO profile_timeline AS
SELECT
    workspace_id,
    if(user_id != '', user_id, anonymous_id)                AS actor_id,
    timestamp,
    event_id,
    event_name,
    source,
    anonymous_id,
    user_id,
    session_id,
    order_id,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    page_url,
    referrer,
    ip_country,
    ip_city,
    device_type,
    os,
    browser,
    value,
    currency,
    properties,
    context
FROM events
WHERE is_bot = 0                                            -- regra 11
  AND (user_id != '' OR anonymous_id != '');                -- precisa de âncora de pessoa
-- Leitura (timeline DESC, cursor por (timestamp,event_id)):
--   SELECT ... FROM profile_timeline
--   WHERE workspace_id = {ws} AND actor_id IN {actors:Array(String)}
--     AND (timestamp < {cts} OR (timestamp = {cts} AND event_id < {cid)))  -- cursor
--   ORDER BY timestamp DESC, event_id DESC LIMIT {n}
-- (o ProfilesService lê da `events` raw por padrão; apontá-lo aqui é a aceleração).
