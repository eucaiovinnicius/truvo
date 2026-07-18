-- ============================================================================
--  M8 — IDENTITY RESOLUTION + DEDUP · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  touchpoints — série de "toques" de marketing por PESSOA (canonical_id), a
--  matéria-prima da atribuição. Cada linha é uma interação com canal/UTM,
--  opcionalmente amarrada a um clique (`click_id`) e/ou a uma conversão
--  (`order_id`). É denormalizada de propósito (o `canonical_id` é gravado na
--  linha) para o caminho quente do M7 — por isso o stitching RETROATIVO precisa
--  reescrever `canonical_id` após um merge (ALTER ... UPDATE; ver worker do M8).
--
--  >> M7 (Attribution Engine) CONSOME esta tabela: lê os touchpoints de um
--     canonical_id ORDENADOS por `ts` para montar conversion paths e distribuir
--     crédito (last_click / linear / etc.). O ORDER BY abaixo serve exatamente
--     esse padrão de leitura.
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--   · regra 5  → nada de IP bruto aqui (canal/UTM já são derivados pós-enrich).
--   · regra 11 → `is_bot` fica na linha (auditável), mas o M7 filtra `is_bot = 0`.
--   · regra 2/10 → dedup de `order_id` por SOURCE_PRIORITY é feita ANTES, no
--                  consumer do M2; `source` é preservado aqui p/ desempate/leitura.
--
--  Executar depois de 02-events.sql. (05 não colide com 02/03/04.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- touchpoints — ReplacingMergeTree. Idempotência final por `event_id`
-- (a mesma interação reprocessada colapsa p/ 1 linha, mantendo o maior _version).
-- A chave de ordenação (workspace_id, canonical_id, ts, event_id) inclui event_id
-- para preservar toques distintos no MESMO instante e ainda colapsar duplicatas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS touchpoints
(
    workspace_id    String,
    canonical_id    String,
    ts              DateTime64(3, 'UTC'),

    channel         LowCardinality(String) DEFAULT '',   -- paid_search, paid_social, email, organic, referral, direct...
    utm_source      LowCardinality(String) DEFAULT '',
    utm_medium      LowCardinality(String) DEFAULT '',
    utm_campaign    String DEFAULT '',

    click_id        String DEFAULT '',
    order_id        String DEFAULT '',                    -- preenchido no toque de conversão

    -- proveniência / dedup (regra 2/10): a fonte vencedora do order_id vem do M2.
    source          LowCardinality(String) DEFAULT '',
    event_id        String DEFAULT '',                    -- idempotência (ReplacingMergeTree)
    value           Float64 DEFAULT 0,                    -- receita quando é conversão
    is_bot          UInt8 DEFAULT 0,                      -- regra 11: M7 filtra is_bot = 0

    -- versão p/ ReplacingMergeTree (ms de processamento; reinserção mais nova vence)
    _version        UInt64 DEFAULT toUnixTimestamp64Milli(now64(3)),

    INDEX idx_order_id order_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_click_id click_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(ts)                                 -- retenção/TTL por mês
ORDER BY (workspace_id, canonical_id, ts, event_id)       -- regra 1: workspace_id 1º; padrão de leitura do M7
SETTINGS index_granularity = 8192;

-- ---------------------------------------------------------------------------
-- STITCHING RETROATIVO (worker do M8 — apps/consumer/src/identity):
-- após um merge (loser → winner), os touchpoints históricos do canonical perdedor
-- precisam apontar para o vencedor. Reescrita idempotente e reprocessável:
--
--   ALTER TABLE touchpoints
--     UPDATE canonical_id = {winner:String}
--     WHERE workspace_id = {ws:String} AND canonical_id = {loser:String};
--
-- É uma mutation (pesada) — o worker aplica com checkpoint por (ws, loser) e é
-- seguro repetir (reaplicar com canonical_id já = winner é no-op). Ver // TODO(live).
-- Os EVENTOS crus (tabela `events`) NÃO são mutados por linha: a resolução de
-- canonical p/ eventos históricos é feita por JOIN em identity_links na leitura
-- (mais barato que reescrever bilhões de linhas). Ver notes do M8.
-- ---------------------------------------------------------------------------
