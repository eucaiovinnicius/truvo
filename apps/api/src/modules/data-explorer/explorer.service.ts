import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { getLogClient, getReadClient, getSandboxClient, resolveDateRange } from './infra';
import { compileSpec, type CompileMeta } from './compiler/compile';
import { DEFAULT_LIMITS, FieldError, PREVIEW_LIMITS } from './compiler/catalog';
import { validateGuardedSql, type SqlValidation } from './compiler/sql-allowlist';
import type { ExplorerQuerySpecInput } from './compiler/spec';

/**
 * M16 — ExplorerService: executa `ExplorerQuerySpec` compilado e SQL guardado,
 * aplica a marca de incerteza de reconciliação (regra 12), registra auditoria em
 * `explorer_query_log` e trata estouro de limite como `aborted` — NUNCA resultado
 * parcial disfarçado (PRD §7 M16). Toda leitura é escopada por workspace_id (regra
 * 1) e is_bot=0 (regra 11) via compilador (regra 19).
 */

export type ExecMode = 'query' | 'preview' | 'run' | 'sql' | 'validate';
export type ExecStatus = 'ok' | 'aborted' | 'error';

export interface UncertaintyMark {
  uncertain: boolean;
  uncertain_days: number;
  max_gap: number | null;
}

export interface ExecResult {
  status: ExecStatus;
  /** Motivo do abort/erro (timeout|quota_exceeded|result_truncated|memory_exceeded|…). */
  reason?: string;
  insight_type?: string;
  window?: { start: string; end: string };
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  meta?: CompileMeta;
  uncertainty?: UncertaintyMark;
  cost?: { duration_ms: number; result_rows: number };
  query_id: string;
}

interface LogEntry {
  workspaceId: string;
  userId?: string;
  kind: 'visual' | 'sql';
  mode: ExecMode;
  insightType?: string;
  insightId?: string;
  status: ExecStatus;
  abortReason?: string;
  uncertain?: boolean;
  sql?: string;
  spec?: unknown;
  durationMs?: number;
  resultRows?: number;
  queryId: string;
}

@Injectable()
export class ExplorerService {
  private readonly logger = new Logger(ExplorerService.name);

  // ─────────────────────────── modelo visual ───────────────────────────

  /**
   * Executa um spec visual. `mode`:
   *  · 'query'/'run' → limites do plano (DEFAULT_LIMITS — // TODO(live): por plano/M11);
   *  · 'preview'     → limites agressivos (amostrado/barato) p/ o construtor visual.
   *
   * `workspaceId` vem SEMPRE da sessão/guard (regra 19). O compilador injeta
   * workspace_id/is_bot/janela — o spec não os controla.
   */
  async executeSpec(
    workspaceId: string,
    userId: string | undefined,
    spec: ExplorerQuerySpecInput,
    mode: ExecMode = 'query',
    insightId?: string,
  ): Promise<ExecResult> {
    const queryId = ulid();
    const isPreview = mode === 'preview';
    const limits = isPreview ? PREVIEW_LIMITS : DEFAULT_LIMITS;
    const { start, end } = resolveDateRange(spec.date_range, isPreview ? 7 : 30);

    let compiled;
    try {
      compiled = compileSpec(spec, { workspaceId, start, end, limits });
    } catch (err) {
      if (err instanceof FieldError) {
        // Erro de vocabulário/allowlist → 422 (campo fora do catálogo, etc.).
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const ch = getReadClient();
    const started = Date.now();
    try {
      const rs = await ch.query({
        query: compiled.sql,
        query_params: compiled.params,
        format: 'JSONEachRow',
      });
      const rows = await rs.json<Record<string, unknown>>();
      const durationMs = Date.now() - started;

      const uncertainty = compiled.meta.touchesRevenue
        ? await this.reconciliationMark(workspaceId, start, end)
        : undefined;

      const result: ExecResult = {
        status: 'ok',
        insight_type: compiled.meta.insightType,
        window: { start: start.toISOString(), end: end.toISOString() },
        columns: rows[0] ? Object.keys(rows[0]) : [],
        rows,
        meta: compiled.meta,
        uncertainty,
        cost: { duration_ms: durationMs, result_rows: rows.length },
        query_id: queryId,
      };

      void this.logQuery({
        workspaceId,
        userId,
        kind: 'visual',
        mode,
        insightType: compiled.meta.insightType,
        insightId,
        status: 'ok',
        uncertain: uncertainty?.uncertain,
        sql: compiled.sql,
        spec,
        durationMs,
        resultRows: rows.length,
        queryId,
      });

      return result;
    } catch (err) {
      const reason = classifyAbort(err);
      const durationMs = Date.now() - started;
      const status: ExecStatus = reason ? 'aborted' : 'error';
      if (!reason) {
        this.logger.error(
          `explorer query falhou (ws=${workspaceId}, qid=${queryId}): ${errMessage(err)}`,
        );
      }
      void this.logQuery({
        workspaceId,
        userId,
        kind: 'visual',
        mode,
        insightType: compiled.meta.insightType,
        insightId,
        status,
        abortReason: reason ?? 'execution_error',
        sql: compiled.sql,
        spec,
        durationMs,
        queryId,
      });
      return {
        status,
        reason: reason ?? 'execution_error',
        insight_type: compiled.meta.insightType,
        window: { start: start.toISOString(), end: end.toISOString() },
        meta: compiled.meta,
        query_id: queryId,
      };
    }
  }

  // ─────────────────────────── modo SQL guardado ───────────────────────────

  /** Valida (AST allowlist) sem executar. POST /v1/explorer/sql/validate. */
  validateSql(workspaceId: string, userId: string | undefined, sql: string): SqlValidation {
    const v = validateGuardedSql(sql);
    void this.logQuery({
      workspaceId,
      userId,
      kind: 'sql',
      mode: 'validate',
      insightType: 'sql',
      status: v.ok ? 'ok' : 'error',
      abortReason: v.ok ? undefined : 'validation_failed',
      sql: v.normalized ?? sql,
      queryId: ulid(),
    });
    return v;
  }

  /**
   * Executa SQL guardado no sandbox read-only. Ordem: validate (AST) → sandbox
   * (usuário read-only + ROW POLICY por workspace via setting de sessão + limites)
   * → paginar. FAIL-CLOSED: sem sandbox provisionado, recusa (503) — nunca cai no
   * cluster de escrita/ingestão.
   */
  async runGuardedSql(
    workspaceId: string,
    userId: string | undefined,
    sql: string,
  ): Promise<ExecResult> {
    const queryId = ulid();
    const v = validateGuardedSql(sql);
    if (!v.ok) {
      void this.logQuery({
        workspaceId,
        userId,
        kind: 'sql',
        mode: 'sql',
        insightType: 'sql',
        status: 'error',
        abortReason: 'validation_failed',
        sql,
        queryId,
      });
      throw new BadRequestException(v.reason ?? 'SQL inválido');
    }

    const sandbox = getSandboxClient();
    if (!sandbox) {
      // Infra do sandbox (usuário read-only + ROW POLICY + QUOTA + pool) não
      // provisionada. // TODO(live): 08-explorer.sql. Fail-closed.
      void this.logQuery({
        workspaceId,
        userId,
        kind: 'sql',
        mode: 'sql',
        insightType: 'sql',
        status: 'error',
        abortReason: 'sandbox_unavailable',
        sql: v.normalized,
        queryId,
      });
      throw new ServiceUnavailableException(
        'Sandbox de SQL não provisionado (usuário read-only + ROW POLICY + QUOTA). Ver TODO(live).',
      );
    }

    const started = Date.now();
    try {
      const rs = await sandbox.query({
        query: v.normalized as string,
        format: 'JSONEachRow',
        clickhouse_settings: {
          // ROW POLICY por workspace amarrada à sessão (regra 1) — do servidor,
          // NUNCA do body. A policy usa getSetting('SQL_explorer_workspace_id').
          SQL_explorer_workspace_id: workspaceId,
          max_execution_time: DEFAULT_LIMITS.maxExecutionTime,
          max_rows_to_read: String(DEFAULT_LIMITS.maxRowsToRead),
          max_bytes_to_read: String(DEFAULT_LIMITS.maxBytesToRead),
          max_memory_usage: String(DEFAULT_LIMITS.maxMemoryUsage),
          max_result_rows: String(DEFAULT_LIMITS.maxResultRows),
          result_overflow_mode: 'throw',
          timeout_overflow_mode: 'throw',
          readonly: '1',
        },
      });
      const rows = await rs.json<Record<string, unknown>>();
      const durationMs = Date.now() - started;
      void this.logQuery({
        workspaceId,
        userId,
        kind: 'sql',
        mode: 'sql',
        insightType: 'sql',
        status: 'ok',
        sql: v.normalized,
        durationMs,
        resultRows: rows.length,
        queryId,
      });
      return {
        status: 'ok',
        columns: rows[0] ? Object.keys(rows[0]) : [],
        rows,
        cost: { duration_ms: durationMs, result_rows: rows.length },
        query_id: queryId,
      };
    } catch (err) {
      const reason = classifyAbort(err);
      const durationMs = Date.now() - started;
      const status: ExecStatus = reason ? 'aborted' : 'error';
      if (!reason) {
        this.logger.error(`explorer sql falhou (ws=${workspaceId}, qid=${queryId}): ${errMessage(err)}`);
      }
      void this.logQuery({
        workspaceId,
        userId,
        kind: 'sql',
        mode: 'sql',
        insightType: 'sql',
        status,
        abortReason: reason ?? 'execution_error',
        sql: v.normalized,
        durationMs,
        queryId,
      });
      return { status, reason: reason ?? 'execution_error', query_id: queryId };
    }
  }

  // ─────────────────────────── reconciliação (regra 12) ───────────────────────────

  /**
   * Lê `reconciliation_daily` (M14) no período e marca incerteza se algum dia estiver
   * `uncertain` (gap > limiar). Best-effort: falha aqui não bloqueia o insight.
   */
  private async reconciliationMark(
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<UncertaintyMark> {
    try {
      const ch = getReadClient();
      const rs = await ch.query({
        query: `
          SELECT
            countIf(status = 'uncertain') AS uncertain_days,
            max(reconciliation_gap)       AS max_gap
          FROM reconciliation_daily FINAL
          WHERE workspace_id = {ws:String}
            AND day >= {start:Date}
            AND day <= {end:Date}`,
        query_params: {
          ws: workspaceId,
          start: toChDate(start),
          end: toChDate(end),
        },
        format: 'JSONEachRow',
      });
      const rows = await rs.json<{ uncertain_days: number | string; max_gap: number | string | null }>();
      const first = rows[0];
      const uncertainDays = Number(first?.uncertain_days ?? 0) || 0;
      const maxGap = first?.max_gap == null ? null : Number(first.max_gap);
      return {
        uncertain: uncertainDays > 0,
        uncertain_days: uncertainDays,
        max_gap: Number.isFinite(maxGap as number) ? maxGap : null,
      };
    } catch (err) {
      this.logger.warn(`marca de incerteza indisponível (ws=${workspaceId}): ${errMessage(err)}`);
      return { uncertain: false, uncertain_days: 0, max_gap: null };
    }
  }

  // ─────────────────────────── auditoria ───────────────────────────

  /** Insert best-effort em explorer_query_log (auditoria + base de cota do M11). */
  private async logQuery(entry: LogEntry): Promise<void> {
    try {
      await getLogClient().insert({
        table: 'explorer_query_log',
        values: [
          {
            workspace_id: entry.workspaceId,
            query_id: entry.queryId,
            user_id: entry.userId ?? '',
            kind: entry.kind,
            mode: entry.mode,
            insight_type: entry.insightType ?? '',
            insight_id: entry.insightId ?? '',
            status: entry.status,
            abort_reason: entry.abortReason ?? '',
            uncertain: entry.uncertain ? 1 : 0,
            sql: entry.sql ?? '',
            spec: entry.spec ? JSON.stringify(entry.spec) : '{}',
            result_rows: entry.resultRows ?? 0,
            duration_ms: entry.durationMs ?? 0,
          },
        ],
        format: 'JSONEachRow',
      });
    } catch (err) {
      this.logger.warn(`falha ao registrar explorer_query_log: ${errMessage(err)}`);
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Formata Date → 'YYYY-MM-DD' (tipo Date do ClickHouse). */
function toChDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Classifica a mensagem de erro do ClickHouse num motivo de ABORT conhecido, ou
 * null se não for um estouro de limite (aí é erro de execução real). Honra a regra:
 * estouro vira status 'aborted', nunca resultado parcial (regra 12 / PRD §7 M16).
 */
function classifyAbort(err: unknown): string | null {
  const msg = errMessage(err).toLowerCase();
  if (/memory_limit|memory limit|max_memory_usage|too much memory/.test(msg)) {
    return 'memory_exceeded';
  }
  if (/timeout|timed out|max_execution_time|execution time|too slow/.test(msg)) {
    return 'timeout';
  }
  if (/quota/.test(msg)) {
    return 'quota_exceeded';
  }
  if (/max_result_rows|too many rows|limit for result|result.*rows/.test(msg)) {
    return 'result_truncated';
  }
  // Limites de leitura/scan (rows/bytes to read) e demais tetos → abort genérico.
  if (
    /max_rows_to_read|max_bytes_to_read|rows or bytes to read|rows to read|bytes to read|limit for rows|limit exceeded|exceeded.*limit/.test(
      msg,
    )
  ) {
    return 'limit_exceeded';
  }
  return null;
}
