-- ============================================================================
--  M16 — DATA EXPLORER (motor de query próprio) · ClickHouse DDL
--  Banco: ${CLICKHOUSE_DB:-truvo}
--
--  explorer_query_log — auditoria/telemetria de TODA execução self-serve do Data
--  Explorer (modelo visual + SQL guardado). É a trilha de auditoria exigida pelo
--  PRD §7 M16 ("quem, quando, SQL, custo real") e a base do enforcement de cota de
--  compute (regra 19 / metering do M11). Append-only.
--
--  REGRAS DE NEGÓCIO EMBUTIDAS NO STORAGE:
--   · regra 1  → workspace_id é SEMPRE a 1ª coluna do ORDER BY (isolamento tenant).
--                Toda leitura desta tabela também filtra workspace_id no WHERE.
--   · regra 19 → o compilador injeta workspace_id + is_bot=0 + janela nas queries
--                de dado; ESTA tabela é o log dessas execuções (não é dado de
--                evento), por isso NÃO carrega is_bot — é metadado operacional.
--   · regra 12 → `uncertain` marca execuções cujo período tinha reconciliation_gap
--                acima do limiar (a "marca de incerteza" atravessa o explorador).
--
--  status:      'ok'       execução completa dentro dos limites.
--               'aborted'  estourou timeout/cota/max_result_rows/memória — NUNCA
--                          um resultado parcial disfarçado (ver abort_reason).
--               'error'    falha de validação/execução (ver abort_reason).
--
--  Executar depois de 02-events.sql. NN = 08 (05/06/07 são M8/M14/M6).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- explorer_query_log — MergeTree append-only. Uma linha por execução (query,
-- preview, run de insight salvo, validate e sql). Guarda o SQL compilado/cliente
-- e o spec p/ auditoria, mais os contadores de custo real (linhas/bytes/memória/
-- tempo) lidos de system.query_log/response headers pelo serviço (// TODO(live)).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS explorer_query_log
(
    workspace_id    String,
    ts              DateTime64(3, 'UTC') DEFAULT now64(3),
    query_id        String DEFAULT '',                   -- id da execução (ULID do serviço)

    user_id         String DEFAULT '',                   -- quem executou (M1 user id)
    kind            LowCardinality(String) DEFAULT '',    -- 'visual' | 'sql'
    mode            LowCardinality(String) DEFAULT '',    -- 'query' | 'preview' | 'run' | 'validate' | 'sql'
    insight_type    LowCardinality(String) DEFAULT '',    -- trends|funnel|retention|path|breakdown|sql
    insight_id      String DEFAULT '',                    -- quando roda um insight salvo

    status          LowCardinality(String) DEFAULT 'ok',  -- 'ok' | 'aborted' | 'error'
    abort_reason    LowCardinality(String) DEFAULT '',    -- 'timeout'|'quota_exceeded'|'result_truncated'|'memory_exceeded'|...
    uncertain       UInt8 DEFAULT 0,                       -- regra 12: período não reconciliado

    -- SQL/spec p/ auditoria (o SQL compilado é seguro/parametrizado; o do cliente é o guardado)
    sql             String DEFAULT '',
    spec            String DEFAULT '{}',

    -- custo real (preenchido pelo serviço a partir de system.query_log / headers)
    rows_read       UInt64 DEFAULT 0,
    bytes_read      UInt64 DEFAULT 0,
    result_rows     UInt64 DEFAULT 0,
    memory_usage    UInt64 DEFAULT 0,
    duration_ms     UInt32 DEFAULT 0,

    -- versão (ms) — não dedup, só ordenação estável se necessário
    _version        UInt64 DEFAULT toUnixTimestamp64Milli(now64(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (workspace_id, ts, query_id)                     -- regra 1: workspace_id 1º
TTL toDateTime(ts) + INTERVAL 180 DAY                      -- retenção de auditoria (ajustável)
SETTINGS index_granularity = 8192;
-- Leitura (auditoria/cota): sempre `WHERE workspace_id = {ws}` + janela de ts.


-- ---------------------------------------------------------------------------
-- SANDBOX DO MODO SQL GUARDADO (infra — // TODO(live), NÃO criado por este DDL):
--
-- O modo SQL (Agency/Enterprise) roda SOMENTE contra views virtuais por workspace,
-- num pool de leitura dedicado, com usuário read-only + ROW POLICY + QUOTA. Isto é
-- provisionamento de INFRA do ClickHouse (fora do schema de tabelas do app):
--
--   -- usuário read-only dedicado (perfil readonly=1; sem DDL/DML/SET sensível):
--   CREATE USER IF NOT EXISTS truvo_explorer IDENTIFIED BY '${EXPLORER_CH_PASSWORD}'
--     SETTINGS PROFILE 'readonly';
--
--   -- namespace lógico de views já filtradas (uma por tabela base):
--   CREATE DATABASE IF NOT EXISTS explorer;
--   CREATE VIEW explorer.events AS SELECT * FROM ${CLICKHOUSE_DB}.events;       -- filtragem via ROW POLICY
--   -- idem: explorer.touchpoints, explorer.sessions, explorer.conversions
--
--   -- ROW POLICY por workspace amarra o tenant à sessão (cinta de segurança):
--   CREATE ROW POLICY IF NOT EXISTS explorer_ws_events ON ${CLICKHOUSE_DB}.events
--     FOR SELECT USING workspace_id = getSetting('SQL_explorer_workspace_id') AND is_bot = 0
--     TO truvo_explorer;
--
--   -- QUOTA por workspace/usuário (janela de 1h): teto de tempo/linhas/bytes/memória/resultado.
--   CREATE QUOTA IF NOT EXISTS explorer_quota
--     FOR INTERVAL 1 HOUR MAX execution_time = 600, read_rows = 2000000000,
--       read_bytes = 200000000000, result_rows = 5000000 TO truvo_explorer;
--
-- Ordem de execução (ver ExplorerService.runGuardedSql): validate (AST allowlist,
-- código do app) → aplicar settings/quota → executar como truvo_explorer com ROW
-- POLICY no pool de leitura → paginar. `explorer.conversions`/`explorer.sessions`
-- mapeiam p/ events(event_name='purchase')/sessions_mv (decisão pendente do PRD).
-- ---------------------------------------------------------------------------
