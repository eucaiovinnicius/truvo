-- ============================================================================
--  M7 — ATTRIBUTION ENGINE · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  O M7 NÃO tem tabela própria de storage: ele LÊ a matéria-prima já pronta —
--   · touchpoints (05-identity.sql) → toques de marketing por PESSOA (canonical_id),
--                                     ordenados por `ts`, com channel/UTM/click_id e,
--                                     no toque de conversão, `order_id` + `value`.
--   · events (02-events.sql)        → usado só quando se precisa de UTMs mais finas
--                                     (utm_content/utm_term) que hoje NÃO existem em
--                                     touchpoints — ver TODO(live) no fim do arquivo.
--
--  O CRÉDITO por touchpoint (last_click / first_click / linear / position_based /
--  time_decay) é distribuído na CAMADA DE APLICAÇÃO (apps/api/.../attribution): o
--  serviço puxa, por canonical_id, os toques ORDENADOS e reconstrói cada caminho de
--  conversão dentro da janela [conv_ts - window, conv_ts], então reparte 1.0 de
--  crédito entre os toques. Modelos como position_based (U 40/40/20) e time_decay
--  (e^(-λ·dias)) são calculados em TS — determinístico e testável — em vez de SQL.
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NA LEITURA:
--   · regra 1  → TODA query filtra `workspace_id` (1ª coluna do ORDER BY de touchpoints).
--   · regra 11 → TODA query filtra `is_bot = 0` (bots nunca contam para atribuição).
--   · regra 2/10 → dedup de `order_id` por SOURCE_PRIORITY já foi feita no consumer
--                  do M2; aqui uma conversão é `order_id != ''` num toque, deduplicada
--                  por (canonical_id, order_id) na aplicação.
--
--  Executar depois de 05-identity.sql (cria `touchpoints`). NN = 08 (não colide).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CLASSIFICAÇÃO DE CANAL (channel_resolved) — fonte única do rótulo de canal.
-- `touchpoints.channel` já vem preenchido pelo stitching do M8 na maioria dos
-- casos; quando vazio, derivamos o canal das UTMs. Esta MESMA expressão vive como
-- constante no serviço (attribution.constants.ts → CHANNEL_RESOLVE_SQL) e é usada
-- na leitura — mantê-las EM SINCRONIA. É um expression puro de colunas do servidor
-- (nenhum valor do cliente é interpolado), logo é seguro.
--
-- v_attribution_touchpoints — superfície de leitura ESTÁVEL e opcional: aplica
-- `is_bot = 0` (regra 11) e expõe `channel_resolved`. Consumidores AINDA precisam
-- filtrar `workspace_id` (regra 1) — uma VIEW não isola tenant sozinha.
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_attribution_touchpoints AS
SELECT
    workspace_id,
    canonical_id,
    ts,
    event_id,
    order_id,
    value,
    click_id,
    utm_source,
    utm_medium,
    utm_campaign,
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
    )                                                                   AS channel_resolved
FROM touchpoints
WHERE is_bot = 0;                                                       -- regra 11

-- ---------------------------------------------------------------------------
-- PADRÃO DE LEITURA DO SERVIÇO (referência — a query real é montada no TS).
-- O serviço lê a tabela BASE `touchpoints` DIRETAMENTE (aplicando `is_bot = 0` e a
-- expressão de canal inline via CHANNEL_RESOLVE_SQL), para NÃO depender de esta
-- VIEW ter sido aplicada. A VIEW acima é um equivalente 1:1 (mesma semântica),
-- oferecido como superfície de leitura estável para outros consumidores/BI:
--
--   SELECT
--     canonical_id,
--     groupArray((
--       toUnixTimestamp64Milli(ts), <CHANNEL_RESOLVE_SQL>,
--       utm_source, utm_medium, utm_campaign,
--       order_id, value, event_id
--     )) AS touches
--   FROM touchpoints
--   WHERE workspace_id = {ws:String}                 -- regra 1
--     AND is_bot = 0                                 -- regra 11
--     AND ts >= {min_ts:DateTime64(3)}               -- min_ts = start - window
--     AND ts <  {end:DateTime64(3)}
--   GROUP BY canonical_id
--   HAVING countIf(order_id != '' AND ts >= {start:DateTime64(3)}) > 0;
--
-- O serviço então, por canonical: dedup por event_id (ReplacingMergeTree pode ter
-- reinserção), ordena por ts, isola as conversões (order_id != '' na janela de
-- relatório) e, para cada uma, monta o caminho na janela de atribuição e reparte o
-- crédito conforme o modelo. `groupArray` é bounded pelo HAVING (só canonicals que
-- converteram no período). Ver perf/TODO no serviço para volumes muito altos.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- TODO(live) — QUEM POPULA `touchpoints`:
--   Hoje a matéria-prima da atribuição depende do CONSUMER do M2 gravar cada toque
--   e do STITCHING do M8 (apps/consumer/src/identity) reescrever `canonical_id`
--   após merges (ALTER ... UPDATE; ver 05-identity.sql). Enquanto esse pipeline não
--   estiver ligado em produção, `touchpoints` pode estar vazia e os relatórios do M7
--   retornam zeros — a LEITURA já está pronta e correta (este arquivo + o serviço).
--
-- TODO(live) — HIERARQUIA Canal→Campanha→Conjunto→Anúncio (campaign-breakdown):
--   `touchpoints` carrega utm_source/medium/campaign, mas NÃO utm_content/utm_term.
--   Logo o breakdown chega até (canal, source, medium, campanha). Para "Conjunto"
--   (ad set = utm_content) e "Anúncio" (ad = utm_term), o consumer do M2/M8 deve
--   projetar utm_content/utm_term em `touchpoints` (ou o serviço faz JOIN em `events`
--   por event_id). Até lá o serviço expõe os níveis disponíveis e marca o resto.
--
-- TODO(live) — SPEND/ROAS/CAC:
--   spend vem do M10 (Ads), que ainda não existe. O serviço usa um provider
--   (AD_SPEND_PROVIDER) com stub indisponível; ROAS/CAC ficam null e
--   `spend_available=false` até o M10 fornecer o provider real (mesmo padrão do M14).
-- ---------------------------------------------------------------------------
