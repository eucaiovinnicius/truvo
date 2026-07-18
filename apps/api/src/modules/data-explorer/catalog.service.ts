import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { explorerCatalog } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { getReadClient } from './infra';
import {
  DATE_PRESETS,
  FILTER_OPS,
  fieldCatalog,
  FieldError,
  GRANULARITIES,
  isPiiKey,
  MEASURE_METRICS,
  parsePropertyField,
  SOURCES,
  UNIQUE_ON,
  type ExplorerSource,
} from './compiler/catalog';

/**
 * M16 — CatalogService: expõe o vocabulário do explorador (campos, dimensões,
 * measures, operadores) e descobre `properties.*` dinâmicas por AMOSTRAGEM do
 * ClickHouse. É a fonte que a UI usa e um espelho do allowlist do compilador.
 *
 * PII (regra 4/5): a amostragem NUNCA expõe chaves de PII em claro — a blocklist
 * (catalog.ts) filtra `email`/`phone`/`cpf`/`ip_address`/… antes de retornar.
 * Toda leitura filtra workspace_id (regra 1) + is_bot=0 (regra 11).
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** GET /v1/explorer/catalog — campos/dimensões/measures/operadores disponíveis. */
  async getCatalog(workspaceId: string, source: ExplorerSource = 'events') {
    const fields = Object.entries(fieldCatalog(source)).map(([key, def]) => ({
      key,
      column: def.column,
      type: def.type,
      label: def.label,
    }));

    // Entradas custom do workspace (dimensões/measures salvas, propriedades
    // amostradas e cacheadas), exceto PII.
    let custom: Array<{
      entry_type: string;
      key: string;
      label: string | null;
      data_type: string;
      source: string;
    }> = [];
    try {
      const rows = await this.db
        .select()
        .from(explorerCatalog)
        .where(eq(explorerCatalog.workspaceId, workspaceId));
      custom = rows
        .filter((r) => !r.isPii)
        .map((r) => ({
          entry_type: r.entryType,
          key: r.key,
          label: r.label,
          data_type: r.dataType,
          source: r.source,
        }));
    } catch (err) {
      this.logger.warn(`catálogo custom indisponível (ws=${workspaceId}): ${errMessage(err)}`);
    }

    return {
      source,
      sources: Object.keys(SOURCES),
      fields,
      measures: MEASURE_METRICS.map((m) => ({ metric: m })),
      unique_on: Object.keys(UNIQUE_ON[source]),
      filter_ops: FILTER_OPS,
      insight_types: ['trends', 'funnel', 'retention', 'path', 'breakdown'],
      granularities: GRANULARITIES,
      date_presets: Object.keys(DATE_PRESETS),
      custom,
    };
  }

  /**
   * GET /v1/explorer/catalog/properties?event=purchase — descobre chaves de
   * `properties.*` por amostragem (top chaves + tipo inferido). Só fonte `events`.
   *
   * // TODO(live): cachear em explorer_catalog + refresh periódico; detector de PII
   * por amostragem de VALOR (não só nome de chave).
   */
  async sampleProperties(workspaceId: string, event: string | undefined, days = 30) {
    const params: Record<string, unknown> = { ws: workspaceId, days };
    let eventClause = '';
    if (event && event !== '*') {
      eventClause = 'AND event_name = {ev:String}';
      params.ev = event;
    }

    let sampled: Array<{ key: string; occurrences: number; json_type: string }> = [];
    try {
      const ch = getReadClient();
      const rs = await ch.query({
        query: `
          SELECT
            key                               AS key,
            count()                           AS occurrences,
            any(JSONType(properties, key))    AS json_type
          FROM events
          ARRAY JOIN JSONExtractKeys(properties) AS key
          WHERE workspace_id = {ws:String}
            AND is_bot = 0
            AND timestamp >= now() - toIntervalDay({days:UInt32})
            ${eventClause}
          GROUP BY key
          ORDER BY occurrences DESC
          LIMIT 200
          SETTINGS max_execution_time = 10, max_result_rows = 1000, result_overflow_mode = 'break'`,
        query_params: params,
        format: 'JSONEachRow',
      });
      sampled = await rs.json<{ key: string; occurrences: number | string; json_type: string }>().then(
        (rows) =>
          rows.map((r) => ({
            key: String(r.key),
            occurrences: Number(r.occurrences) || 0,
            json_type: String(r.json_type ?? ''),
          })),
      );
    } catch (err) {
      this.logger.warn(`amostragem de properties falhou (ws=${workspaceId}): ${errMessage(err)}`);
    }

    // Blocklist de PII (regra 4/5): chaves sensíveis nunca saem no catálogo.
    return {
      event: event ?? '*',
      properties: sampled
        .filter((p) => !isPiiKey(p.key))
        .map((p) => ({
          field: `properties.${p.key}`,
          key: p.key,
          type: inferType(p.json_type),
          occurrences: p.occurrences,
        })),
      // Contagem do que foi ocultado por PII (transparência, sem expor as chaves).
      pii_hidden: sampled.filter((p) => isPiiKey(p.key)).length,
    };
  }

  /**
   * GET /v1/explorer/catalog/values?field=context.utm_source — autocomplete de
   * valores distintos de um campo do catálogo. Campo fora do catálogo → 422.
   */
  async getValues(
    workspaceId: string,
    field: string,
    source: ExplorerSource = 'events',
    limit = 50,
  ) {
    const { expr, params } = this.resolveDimensionExpr(source, field);
    const capped = Math.max(1, Math.min(limit, 200));

    const ch = getReadClient();
    const rs = await ch.query({
      query: `
        SELECT ${expr} AS value, count() AS occurrences
        FROM ${SOURCES[source].table}
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND ${SOURCES[source].tsColumn} >= now() - toIntervalDay(90)
          AND ${expr} != ''
        GROUP BY value
        ORDER BY occurrences DESC
        LIMIT ${capped}
        SETTINGS max_execution_time = 10, max_result_rows = 500, result_overflow_mode = 'break'`,
      query_params: { ws: workspaceId, ...params },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<{ value: string; occurrences: number | string }>();
    return {
      field,
      values: rows.map((r) => ({ value: String(r.value), occurrences: Number(r.occurrences) || 0 })),
    };
  }

  /**
   * Resolve um campo → expressão String segura (coluna do catálogo OU JSONExtract com
   * a chave como PARÂMETRO). Reusa o allowlist do compilador (catalog.ts). Lança 422
   * em campo fora do catálogo / PII. Espelha compile.ts (mantido em sincronia).
   */
  private resolveDimensionExpr(
    source: ExplorerSource,
    field: string,
  ): { expr: string; params: Record<string, unknown> } {
    try {
      const def = fieldCatalog(source)[field];
      if (def) {
        return { expr: def.type === 'string' ? def.column : `toString(${def.column})`, params: {} };
      }
      const prop = parsePropertyField(field);
      if (prop && source === 'events') {
        return { expr: 'JSONExtractString(properties, {pk:String})', params: { pk: prop.key } };
      }
      throw new FieldError(`campo fora do catálogo: '${field}'`);
    } catch (err) {
      if (err instanceof FieldError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Mapeia o JSONType do ClickHouse p/ o tipo do catálogo. */
function inferType(jsonType: string): 'string' | 'number' | 'boolean' {
  const t = jsonType.toLowerCase();
  if (t.includes('int') || t.includes('float') || t.includes('double') || t.includes('decimal')) {
    return 'number';
  }
  if (t.includes('bool')) return 'boolean';
  return 'string';
}
