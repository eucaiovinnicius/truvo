import { Injectable, Logger } from '@nestjs/common';
import type { Funnel } from '@truvo/db';
import { getClickHouse } from '../events/infra';
import type { FunnelFiltersDto } from './dto/funnel.dto';
import {
  buildBestSourceSql,
  buildDropoffSql,
  buildStatsSql,
  computeFunnelMetrics,
  resolveWindow,
  toChDateTime,
  type FunnelMetrics,
  type StatsSqlInput,
} from './funnel-sql';

export interface BestTrafficSource {
  source: string;
  conversions: number;
  entered: number;
  conversion_rate: number;
}

export interface FunnelStats extends FunnelMetrics {
  funnel_id: string;
  name: string;
  attribution_window_days: number;
  window: { start: string; end: string };
  filters: FunnelFiltersDto;
  best_traffic_source: BestTrafficSource | null;
  /** false quando o ClickHouse está indisponível (dev) — números degradam p/ 0. */
  clickhouse_available: boolean;
  comparison?: {
    window: { start: string; end: string };
    overall_conversion_rate: number;
    delta_overall_conversion_rate: number;
  };
}

export interface DropoffUser {
  user_key: string;
  anonymous_id: string;
  user_id: string;
  last_event_at: string;
  utm_source: string;
  device_type: string;
  ip_country: string;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Motor de cálculo do funil (ClickHouse). Toda query passa `workspace_id` e
 * `is_bot = 0` via os builders de funnel-sql (regras 1 e 11). ClickHouse é
 * best-effort: se indisponível em dev, retorna zeros + `clickhouse_available:false`.
 */
@Injectable()
export class FunnelCalcService {
  private readonly logger = new Logger(FunnelCalcService.name);

  /** GET /v1/funnels/:id/stats — métricas por step + do funil + best source. */
  async stats(
    workspaceId: string,
    funnel: Funnel,
    filters: FunnelFiltersDto,
    compare = false,
  ): Promise<FunnelStats> {
    const window = resolveWindow(filters.start, filters.end, 30);
    const windowSeconds = funnel.attributionWindowDays * 86_400;
    const base: StatsSqlInput = { workspaceId, steps: funnel.steps, windowSeconds, window, filters };

    const empty = computeFunnelMetrics(funnel.steps, [], [], 0);
    const shell: FunnelStats = {
      funnel_id: funnel.id,
      name: funnel.name,
      attribution_window_days: funnel.attributionWindowDays,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      filters,
      best_traffic_source: null,
      clickhouse_available: true,
      ...empty,
    };

    try {
      const metrics = await this.runMetrics(workspaceId, base);
      Object.assign(shell, metrics);
      shell.best_traffic_source = await this.runBestSource(workspaceId, base);

      if (compare) {
        const prev = this.previousWindow(window);
        const prevMetrics = await this.runMetrics(workspaceId, {
          ...base,
          window: prev,
          filters: { ...filters, start: prev.start.toISOString(), end: prev.end.toISOString() },
        });
        shell.comparison = {
          window: { start: prev.start.toISOString(), end: prev.end.toISOString() },
          overall_conversion_rate: prevMetrics.overall_conversion_rate,
          delta_overall_conversion_rate: Number(
            (shell.overall_conversion_rate - prevMetrics.overall_conversion_rate).toFixed(2),
          ),
        };
      }
    } catch (err) {
      // TODO(live): ClickHouse pode não estar no ar em dev / tabela `events` (M2)
      // ainda não criada. Degrada p/ zeros e sinaliza no payload.
      shell.clickhouse_available = false;
      this.logger.warn(`stats: ClickHouse indisponível (${(err as Error).message})`);
    }

    return shell;
  }

  /** GET /v1/funnels/:id/preview — contagem por step nos últimos 30 dias, sem filtros. */
  async preview(workspaceId: string, funnel: Funnel) {
    const window = resolveWindow(undefined, undefined, 30);
    const windowSeconds = funnel.attributionWindowDays * 86_400;
    const base: StatsSqlInput = { workspaceId, steps: funnel.steps, windowSeconds, window, filters: {} };

    let clickhouse_available = true;
    let metrics = computeFunnelMetrics(funnel.steps, [], [], 0);
    try {
      metrics = await this.runMetrics(workspaceId, base);
    } catch (err) {
      clickhouse_available = false;
      this.logger.warn(`preview: ClickHouse indisponível (${(err as Error).message})`);
    }

    return {
      funnel_id: funnel.id,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      total_visitors: metrics.total_visitors,
      overall_conversion_rate: metrics.overall_conversion_rate,
      steps: metrics.steps.map((s) => ({
        step_id: s.step_id,
        name: s.name,
        event: s.event,
        users_entered: s.users_entered,
        conversion_rate: s.conversion_rate,
      })),
      clickhouse_available,
    };
  }

  /** GET /v1/funnels/:id/dropoff/:stepId — usuários que pararam no step (level == idx). */
  async dropoff(
    workspaceId: string,
    funnel: Funnel,
    stepIndex: number,
    filters: FunnelFiltersDto,
    limit: number,
  ): Promise<{ users: DropoffUser[]; count: number; clickhouse_available: boolean }> {
    const n = funnel.steps.length;
    // Ninguém "abandona" após o último step (quem chega lá converteu o funil).
    if (stepIndex >= n) {
      return { users: [], count: 0, clickhouse_available: true };
    }

    const window = resolveWindow(filters.start, filters.end, 30);
    const windowSeconds = funnel.attributionWindowDays * 86_400;
    const { sql, params } = buildDropoffSql({
      workspaceId,
      steps: funnel.steps,
      windowSeconds,
      window,
      filters,
      stepIndex,
      limit,
    });

    try {
      const rows = await this.query<{
        uk: string;
        anonymous_id: string;
        user_id: string;
        last_event_at: string;
        first_source: string;
        device_type: string;
        ip_country: string;
      }>(sql, this.withScope(workspaceId, window, params));

      const users: DropoffUser[] = rows.map((r) => ({
        user_key: r.uk,
        anonymous_id: r.anonymous_id,
        user_id: r.user_id,
        last_event_at: r.last_event_at,
        utm_source: r.first_source,
        device_type: r.device_type,
        ip_country: r.ip_country,
      }));
      return { users, count: users.length, clickhouse_available: true };
    } catch (err) {
      this.logger.warn(`dropoff: ClickHouse indisponível (${(err as Error).message})`);
      return { users: [], count: 0, clickhouse_available: false };
    }
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private async runMetrics(workspaceId: string, input: StatsSqlInput): Promise<FunnelMetrics> {
    const { sql, params } = buildStatsSql(input);
    const rows = await this.query<Record<string, string | number>>(
      sql,
      this.withScope(workspaceId, input.window, params),
    );
    const row = rows[0] ?? {};

    const n = input.steps.length;
    const reached: number[] = [];
    for (let i = 1; i <= n; i++) reached.push(num(row[`r${i}`]));
    const avgToNext: number[] = [];
    for (let i = 1; i < n; i++) avgToNext.push(num(row[`avg_${i}`]));

    return computeFunnelMetrics(input.steps, reached, avgToNext, num(row.total_revenue));
  }

  private async runBestSource(
    workspaceId: string,
    input: StatsSqlInput,
  ): Promise<BestTrafficSource | null> {
    const { sql, params } = buildBestSourceSql(input);
    const rows = await this.query<{ source: string; conversions: string | number; entered: string | number }>(
      sql,
      this.withScope(workspaceId, input.window, params),
    );
    const row = rows[0];
    if (!row) return null;
    const conversions = num(row.conversions);
    const entered = num(row.entered);
    return {
      source: row.source,
      conversions,
      entered,
      conversion_rate: entered > 0 ? Number(((conversions / entered) * 100).toFixed(2)) : 0,
    };
  }

  /** Período anterior de mesma duração, imediatamente antes de [start,end). */
  private previousWindow(window: { start: Date; end: Date }): { start: Date; end: Date } {
    const span = window.end.getTime() - window.start.getTime();
    return { start: new Date(window.start.getTime() - span), end: new Date(window.start.getTime()) };
  }

  /** Injeta ws + janela nos params (regra 1) sobre os params já montados pelo builder. */
  private withScope(
    workspaceId: string,
    window: { start: Date; end: Date },
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...params,
      ws: workspaceId,
      start: toChDateTime(window.start),
      end: toChDateTime(window.end),
    };
  }

  private async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const ch = getClickHouse();
    const rs = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
    return rs.json<T>();
  }
}
