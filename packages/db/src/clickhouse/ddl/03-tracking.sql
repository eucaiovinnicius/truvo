-- M3 — Tracking Layer :: ClickHouse DDL (PRD §7 Módulo 3, §8)
--
-- link_clicks: registro por clique no redirect público `/c/:code`.
-- O contador autoritativo de cliques vive no Postgres (tracking_links.click_count);
-- esta tabela dá a série temporal / detalhe por clique para as stats por link.
--
-- Regra 1: toda query filtra workspace_id — ele encabeça a ORDER BY.
-- Regra 5: IP nunca persistido bruto — apenas ip_country/ip_city (enriquecido no consumer);
--          o redirect NÃO grava IP.
-- Regra 11: is_bot marcado na ingestão e SEMPRE excluído de contagens analíticas.
--
-- As stats de "sessões" e "conversões" por link são lidas da tabela `events` (M2),
-- filtrando startsWith(click_id, 'clk_<code>.') AND is_bot = 0 AND workspace_id = ...

CREATE TABLE IF NOT EXISTS link_clicks
(
  click_id     String,
  workspace_id String,
  link_id      String,
  code         String,
  ts           DateTime64(3) DEFAULT now64(3),
  referrer     String        DEFAULT '',
  user_agent   String        DEFAULT '',
  utm_source   String        DEFAULT '',
  utm_medium   String        DEFAULT '',
  utm_campaign String        DEFAULT '',
  ip_country   LowCardinality(String) DEFAULT '',
  ip_city      String        DEFAULT '',
  is_bot       UInt8         DEFAULT 0
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (workspace_id, code, click_id)
TTL toDateTime(ts) + INTERVAL 24 MONTH;
