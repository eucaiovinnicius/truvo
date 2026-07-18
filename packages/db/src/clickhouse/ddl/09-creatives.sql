-- ============================================================================
--  M10 — CREATIVE ANALYTICS · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  O M10 mostra o ROAS **real** por criativo — as conversões que o Truvo mediu
--  server-side — versus o que a plataforma **reporta**, e o DELTA entre os dois.
--  Duas fontes, dois storages:
--
--   1. creative_daily      → o lado REPORTADO. Métricas que vêm das Ads APIs
--                            (Meta/Google/TikTok): spend, impressões, cliques,
--                            conversões/receita reportadas, por criativo/dia.
--                            Populado pelo sync (apps/api .../creatives/ads).
--
--   2. creative_real_daily → o lado REAL (Truvo). Funil do criativo derivado da
--                            tabela `events` (M2): sessões, checkouts, compras e
--                            receita reais, cruzados por fbclid/gclid/ttclid → ad_id.
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 11 → o lado REAL sai de uma MV que filtra `is_bot = 0`: bots nunca
--                entram no funil/ROAS real. (creative_daily é dado da plataforma,
--                não tem conceito de bot — não se aplica.)
--   · regra 12 → não inventamos número da plataforma: sem sync, `creative_daily`
--                fica vazio e spend/ROAS reportado saem null na leitura.
--
--  CRUZAMENTO click_id → ad_id (PRD §7 M10, fonte 4):
--   A tabela `events` guarda `click_id` (fbclid/gclid/ttclid) e `utm_content`. A
--   convenção de mercado é injetar o ad_id na URL do anúncio via macro dinâmica —
--   Meta `utm_content={{ad.id}}`, Google `utm_content={creative}`, TikTok
--   `utm_content=__CID__`. Por isso a MV usa `utm_content` como `ad_ref` (= ad_id)
--   e deriva a `platform` do `utm_source`. Quando o cliente NÃO usa essa macro, o
--   ad_ref fica em branco e o criativo aparece só com o lado reportado — honesto,
--   sem inventar o cruzamento. // TODO(live): resolver click_id → ad_id também via
--   API/offline conversions da plataforma quando o utm_content não carregar o ad_id.
--
--  Executar depois de 02-events.sql. NN = 09 (não colide com 02..08).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- creative_daily — lado REPORTADO pela plataforma. ReplacingMergeTree(_version):
-- o re-sync do mesmo (workspace, platform, ad_id, dia) colapsa p/ 1 linha,
-- mantendo o maior _version (a leitura mais nova da Ads API vence). Idempotente e
-- reprocessável — o sync pode reescrever uma janela sem duplicar spend.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_daily
(
    workspace_id        String,
    platform            LowCardinality(String),              -- 'meta' | 'google' | 'tiktok'
    ad_id               String,
    day                 Date,

    -- dimensões (denormalizadas p/ o grid; a leitura pega o valor mais recente via argMax)
    ad_account_id       String DEFAULT '',
    campaign_id         String DEFAULT '',
    campaign_name       String DEFAULT '',
    adset_id            String DEFAULT '',
    ad_name             String DEFAULT '',
    creative_type       LowCardinality(String) DEFAULT '',   -- image | video | carousel
    phase               LowCardinality(String) DEFAULT '',   -- TOF | MOF | BOF
    currency            LowCardinality(String) DEFAULT '',

    -- métricas reportadas
    spend               Float64 DEFAULT 0,
    impressions         UInt64  DEFAULT 0,
    clicks              UInt64  DEFAULT 0,
    reach               UInt64  DEFAULT 0,
    platform_conversions Float64 DEFAULT 0,                  -- Float: plataformas reportam fracionário
    platform_revenue    Float64 DEFAULT 0,

    -- versão p/ ReplacingMergeTree (ms de processamento; re-sync mais novo vence)
    _version            UInt64 DEFAULT toUnixTimestamp64Milli(now64(3))
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, platform, ad_id, day)                -- regra 1: workspace_id 1º
SETTINGS index_granularity = 8192;
-- Leitura: SELECT ... FROM creative_daily FINAL WHERE workspace_id = {ws} ...
-- FINAL colapsa as versões do ReplacingMergeTree (um re-sync do mesmo dia não
-- pode duplicar spend). Range por workspace/janela é pequeno — custo aceitável
-- (mesmo padrão de leitura de reconciliation_daily / 06-reconciliation.sql).

-- ---------------------------------------------------------------------------
-- creative_real_daily — lado REAL (Truvo). SummingMergeTree por
-- (workspace_id, platform, ad_ref, dia). Somável nas colunas numéricas; os
-- distintos (sessions/orders) são AggregateFunction(uniq) e mesclam como no
-- AggregatingMergeTree (usar uniqMerge na leitura — MESMO padrão de daily_stats/
-- metrics_daily). Alimentada por creative_real_daily_mv (que já exclui bots).
--
--  Funil do criativo (PRD §7 M10): cliques(plataforma) → sessões → checkouts →
--  compras. As 3 últimas etapas (o lado Truvo) vivem aqui; "cliques" é o lado
--  reportado (creative_daily.clicks). Assim o funil cruza os dois lados por ad_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_real_daily
(
    workspace_id     String,
    platform         LowCardinality(String),                 -- derivada do utm_source
    ad_ref           String,                                 -- utm_content (= ad_id)
    day              Date,

    landing_views    UInt64,                                 -- page_view atribuídas ao criativo
    sessions         AggregateFunction(uniq, String),        -- uniq(session_id)
    checkout_starts  UInt64,                                 -- checkout_started
    purchases        UInt64,                                 -- eventos de receita (purchase/…)
    orders           AggregateFunction(uniq, String),        -- uniq(order_id) — conversões reais dedup
    real_revenue     Float64,                                -- soma value dos eventos de receita
    refunds          Float64                                 -- soma value dos estornos (abate receita)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, platform, ad_ref, day);              -- regra 1: workspace_id 1º

-- MV: deriva o lado real de `events`. Só considera tráfego de plataforma de anúncio
-- (utm_source conhecido) COM ad_ref (utm_content) preenchido, e filtra is_bot = 0
-- (regra 11). A `platform` é mapeada do utm_source (expressão do servidor, sem
-- input do cliente). Um ad_id só colide entre plataformas em teoria — por isso a
-- platform faz parte da chave.
CREATE MATERIALIZED VIEW IF NOT EXISTS creative_real_daily_mv TO creative_real_daily AS
SELECT
    workspace_id,
    multiIf(
        utm_source IN ('facebook','instagram','fb','ig','meta','facebook_ads','fb_ads','fbads'), 'meta',
        utm_source IN ('google','google_ads','googleads','gads','adwords','youtube'),            'google',
        utm_source IN ('tiktok','tiktok_ads','tt','tiktokads'),                                  'tiktok',
        '')                                                                        AS platform,
    utm_content                                                                    AS ad_ref,
    toDate(timestamp)                                                              AS day,
    countIf(event_name = 'page_view')                                             AS landing_views,
    uniqStateIf(session_id, session_id != '')                                     AS sessions,
    countIf(event_name = 'checkout_started')                                      AS checkout_starts,
    countIf(event_name IN ('purchase','checkout_completed','subscription_started')) AS purchases,
    uniqStateIf(order_id,
        order_id != '' AND event_name IN ('purchase','checkout_completed','subscription_started')) AS orders,
    sumIf(value, event_name IN ('purchase','checkout_completed','subscription_started')) AS real_revenue,
    sumIf(value, event_name = 'refund')                                           AS refunds
FROM events
WHERE is_bot = 0                                              -- regra 11
  AND utm_content != ''
  AND utm_source IN (
        'facebook','instagram','fb','ig','meta','facebook_ads','fb_ads','fbads',
        'google','google_ads','googleads','gads','adwords','youtube',
        'tiktok','tiktok_ads','tt','tiktokads')
GROUP BY workspace_id, platform, ad_ref, day;
-- Leitura: sum(landing_views/checkout_starts/purchases/real_revenue/refunds),
--          uniqMerge(sessions), uniqMerge(orders)  +  GROUP BY workspace_id, platform, ad_ref.
