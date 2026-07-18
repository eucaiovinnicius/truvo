import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CurrentWorkspace, type WorkspaceContext } from '../auth/decorators';
import { WorkspaceScopeGuard } from './guards/workspace-scope.guard';
import { MetricsService, type MetricScope } from './metrics.service';
import { segmentFromFilters } from './kpis.service';
import type { MetricKey, SegmentKey, Granularity } from './metrics.constants';
import {
  kpisQuerySchema,
  timeseriesQuerySchema,
  breakdownQuerySchema,
  type KpisQueryDto,
  type TimeseriesQueryDto,
  type BreakdownQueryDto,
} from './dto/metrics-query.dto';

/**
 * M6 — leitura de métricas (PRD §7 M6). Auth: SupabaseAuthGuard + WorkspaceScopeGuard
 * (workspace via header `x-workspace-id`). Toda query filtra workspace_id + is_bot=0.
 */
@Controller('v1/metrics')
@UseGuards(SupabaseAuthGuard, WorkspaceScopeGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** GET /v1/metrics/kpis — KPIs nativos (ROAS/CAC/LTV/AOV/CVR/CPL/MRR). */
  @Get('kpis')
  kpis(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodValidationPipe(kpisQuerySchema)) q: KpisQueryDto,
  ) {
    return this.metrics.nativeKpis(ws.id, scopeFromQuery(q));
  }

  /** GET /v1/metrics/timeseries — série temporal de uma métrica. */
  @Get('timeseries')
  timeseries(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodValidationPipe(timeseriesQuerySchema)) q: TimeseriesQueryDto,
  ) {
    return this.metrics.timeseries(
      ws.id,
      q.metric as MetricKey,
      q.granularity as Granularity,
      scopeFromQuery(q),
    );
  }

  /** GET /v1/metrics/breakdown — breakdown de uma métrica por dimensão. */
  @Get('breakdown')
  breakdown(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Query(new ZodValidationPipe(breakdownQuerySchema)) q: BreakdownQueryDto,
  ) {
    return this.metrics.breakdown(
      ws.id,
      q.metric as MetricKey,
      q.dimension as SegmentKey,
      q.limit,
      scopeFromQuery(q),
    );
  }
}

/** Extrai janela + segmento (allowlist) de um query string flat. */
function scopeFromQuery(q: KpisQueryDto | TimeseriesQueryDto | BreakdownQueryDto): MetricScope {
  return {
    start: q.start,
    end: q.end,
    period: q.period,
    // segmentFromFilters lê só as chaves de segmento da allowlist (ignora metric/etc.).
    segment: segmentFromFilters(q),
  };
}
