import type { ClickHouseClient, FunnelStep } from '@truvo/db';

/**
 * Cálculo compacto de conversão geral do funil p/ o worker de alertas (M5).
 * Standalone de propósito: o consumer não importa do apps/api (fronteira de
 * app). Reusa a MESMA semântica de windowFunnel do motor da API, restrita ao
 * que o alerta precisa (entrou × converteu). Regras 1 e 11 embutidas no WHERE.
 */

const USER_KEY = "if(user_id != '', concat('u_', user_id), concat('a_', anonymous_id))";

function toChDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** Predicado ClickHouse por step (event_name + condições, AND). Params parametrizados. */
function buildPredicates(steps: FunnelStep[]): { exprs: string[]; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const exprs = steps.map((step, i) => {
    const parts: string[] = [];
    const bind = (suffix: string, value: unknown): string => {
      const name = `s${i}_${suffix}`;
      params[name] = value;
      return name;
    };
    parts.push(`event_name = {${bind('evt', step.event)}:String}`);
    const c = step.conditions ?? {};
    if (c.url_contains) {
      parts.push(`positionCaseInsensitive(page_url, {${bind('url', c.url_contains)}:String}) > 0`);
    }
    if (c.element_id) {
      parts.push(`JSONExtractString(properties, 'element_id') = {${bind('eid', c.element_id)}:String}`);
    }
    if (c.property_eq) {
      const keyP = bind('pek', c.property_eq.key);
      const v = c.property_eq.value;
      if (typeof v === 'number') {
        parts.push(`JSONExtractFloat(properties, {${keyP}:String}) = {${bind('pev', v)}:Float64}`);
      } else if (typeof v === 'boolean') {
        parts.push(`JSONExtractBool(properties, {${keyP}:String}) = {${bind('pev', v ? 1 : 0)}:UInt8}`);
      } else {
        parts.push(`JSONExtractString(properties, {${keyP}:String}) = {${bind('pev', v)}:String}`);
      }
    }
    if (c.property_gte) {
      const keyP = bind('pgk', c.property_gte.key);
      parts.push(
        `JSONExtractFloat(properties, {${keyP}:String}) >= {${bind('pgv', c.property_gte.value)}:Float64}`,
      );
    }
    return `(${parts.join(' AND ')})`;
  });
  return { exprs, params };
}

export interface OverallConversion {
  entered: number;
  converted: number;
  rate: number;
}

/**
 * Conversão geral do funil (quem alcançou o último step / quem entrou) nos
 * últimos `lookbackDays`, com janela de atribuição = `attributionWindowDays`.
 */
export async function overallConversion(
  ch: ClickHouseClient,
  workspaceId: string,
  steps: FunnelStep[],
  attributionWindowDays: number,
  lookbackDays: number,
): Promise<OverallConversion> {
  const n = steps.length;
  if (n < 2) return { entered: 0, converted: 0, rate: 0 };

  const { exprs, params } = buildPredicates(steps);
  const windowSec = attributionWindowDays * 86_400;
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86_400_000);

  const sql = `
    SELECT countIf(level >= 1) AS entered, countIf(level >= ${n}) AS converted
    FROM (
        SELECT
          ${USER_KEY} AS uk,
          windowFunnel(${windowSec})(timestamp, ${exprs.join(', ')}) AS level
        FROM events
        WHERE workspace_id = {ws:String}
          AND is_bot = 0
          AND (user_id != '' OR anonymous_id != '')
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
        GROUP BY uk
    )`;

  const rs = await ch.query({
    query: sql,
    query_params: { ...params, ws: workspaceId, start: toChDateTime(start), end: toChDateTime(end) },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ entered: string | number; converted: string | number }>();
  const row = rows[0];
  const entered = row ? Number(row.entered) || 0 : 0;
  const converted = row ? Number(row.converted) || 0 : 0;
  const rate = entered > 0 ? Number(((converted / entered) * 100).toFixed(2)) : 0;
  return { entered, converted, rate };
}
