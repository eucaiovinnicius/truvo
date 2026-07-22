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

-- ---------------------------------------------------------------------------
-- touchpoints_mv — POPULA `touchpoints` a partir de `events` (fecha o TODO(live)
-- do 08-attribution.sql: "QUEM POPULA touchpoints"). Um TOQUE é emitido para:
--   · a ENTRADA de sessão (event_name = 'session_start') → toque de AQUISIÇÃO, que
--     carrega o canal/UTM/click daquela visita; e
--   · toda CONVERSÃO (order_id != '') → toque de CONVERSÃO, que carrega order_id +
--     value para o M7 detectar a conversão e repartir crédito.
-- Só emite quando há PESSOA (user_id ou anonymous_id). O `canonical_id` provisório
-- segue o MESMO convênio do M8 (usr_<user_id> > anon_<anonymous_id>, ver
-- identity.service.ts) — o stitching retroativo (worker M8) reescreve `canonical_id`
-- após merges. `channel` fica '' e é resolvido na LEITURA (CHANNEL_RESOLVE_SQL /
-- v_attribution_touchpoints, 08-attribution.sql) — fonte única do rótulo de canal.
-- `is_bot` é preservado na linha (auditável); o M7 filtra is_bot = 0 na leitura.
--
-- CONVENÇÃO: um toque por sessão (session_start), padrão de mercado (GA-like);
-- cliques mid-sessão não viram toque próprio. Se um cliente não emitir session_start,
-- adicionar aqui a 1ª página com sinal de marketing. // TODO(live): projetar também
-- utm_content/utm_term p/ o breakdown do M7 chegar a conjunto/anúncio.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS touchpoints_mv TO touchpoints AS
SELECT
    workspace_id,
    multiIf(user_id != '',      concat('usr_', user_id),
            anonymous_id != '', concat('anon_', anonymous_id),
            '')                                             AS canonical_id,
    timestamp                                               AS ts,
    utm_source,
    utm_medium,
    utm_campaign,
    click_id,
    order_id,
    source,
    event_id,
    value,
    is_bot
FROM events
WHERE (user_id != '' OR anonymous_id != '')
  AND (event_name = 'session_start' OR order_id != '');
-- Leitura: o serviço do M7 agrupa por canonical_id, ordena por ts e reparte crédito
-- (last_click/linear/…); backfill de eventos históricos: INSERT INTO touchpoints
-- SELECT (mesmo predicado) — ReplacingMergeTree(_version) dedup por event_id.
