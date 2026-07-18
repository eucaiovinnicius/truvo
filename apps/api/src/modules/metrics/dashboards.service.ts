import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `dashboards` só existe em @truvo/db após o barrel
// `schema/index.ts` re-exportar `./metrics` (ver StructuredOutput.schemaExports).
import {
  dashboards,
  type Dashboard,
  type DashboardLayout,
  type DashboardWidget,
  type KpiFilters,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { MetricsService, type MetricScope } from './metrics.service';
import { KpisService, segmentFromFilters } from './kpis.service';
import {
  METRIC_EXPRESSIONS,
  SEGMENT_COLUMNS,
  type Granularity,
  type MetricKey,
  type SegmentKey,
} from './metrics.constants';
import type { CreateDashboardDto, UpdateDashboardDto } from './dto/dashboard.dto';

/** Overrides globais de janela ao renderizar um dashboard. */
export interface DashboardOverrides {
  start?: string;
  end?: string;
  period?: string;
}

const EMPTY_LAYOUT: DashboardLayout = { widgets: [] };

/** View de gestão (dono) de um dashboard. */
export interface DashboardView {
  id: string;
  name: string;
  description: string | null;
  layout: DashboardLayout;
  is_public: boolean;
  public_token: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class DashboardsService {
  private readonly logger = new Logger(DashboardsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metrics: MetricsService,
    private readonly kpis: KpisService,
  ) {}

  // ─────────────────────────── CRUD ───────────────────────────

  async create(
    workspaceId: string,
    userId: string | undefined,
    dto: CreateDashboardDto,
  ): Promise<DashboardView> {
    const now = new Date();
    const [row] = await this.db
      .insert(dashboards)
      .values({
        id: ulid(),
        workspaceId,
        name: dto.name,
        description: dto.description ?? null,
        layout: (dto.layout as DashboardLayout | undefined) ?? EMPTY_LAYOUT,
        publicToken: null,
        createdBy: userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('falha ao criar dashboard');
    return toDashboardView(row);
  }

  async list(workspaceId: string): Promise<DashboardView[]> {
    const rows = await this.db
      .select()
      .from(dashboards)
      .where(eq(dashboards.workspaceId, workspaceId))
      .orderBy(desc(dashboards.createdAt));
    return rows.map(toDashboardView);
  }

  async get(workspaceId: string, id: string): Promise<DashboardView> {
    return toDashboardView(await this.getOwned(workspaceId, id));
  }

  async update(workspaceId: string, id: string, dto: UpdateDashboardDto): Promise<DashboardView> {
    const current = await this.getOwned(workspaceId, id);

    const patch: Partial<Dashboard> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description ?? null;
    if (dto.layout !== undefined) patch.layout = dto.layout as DashboardLayout;
    // Compartilhamento read-only: liga (gera token se ainda não tem) / desliga (limpa).
    if (dto.is_public !== undefined) {
      patch.publicToken = dto.is_public ? current.publicToken ?? `dsh_${ulid()}` : null;
    }

    const [row] = await this.db
      .update(dashboards)
      .set(patch)
      .where(and(eq(dashboards.id, id), eq(dashboards.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new NotFoundException('dashboard não encontrado');
    return toDashboardView(row);
  }

  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    const [row] = await this.db
      .delete(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.workspaceId, workspaceId)))
      .returning({ id: dashboards.id });
    if (!row) throw new NotFoundException('dashboard não encontrado');
    return { id: row.id, deleted: true };
  }

  // ─────────────────── Resolução de dados (widgets) ───────────────────

  /** GET /:id/data — resolve todos os widgets do dashboard (dono autenticado). */
  async resolveData(workspaceId: string, id: string, overrides: DashboardOverrides = {}) {
    const row = await this.getOwned(workspaceId, id);
    return this.renderWidgets(row, overrides);
  }

  /**
   * GET /public/:token — compartilhamento read-only. O workspace é resolvido
   * SERVER-SIDE pelo registro do dashboard (row.workspaceId), NUNCA a partir do
   * request. Sem token válido → 404.
   */
  async resolvePublic(token: string, overrides: DashboardOverrides = {}) {
    const clean = token.trim();
    if (!clean) throw new NotFoundException('dashboard não encontrado');
    const [row] = await this.db
      .select()
      .from(dashboards)
      .where(eq(dashboards.publicToken, clean))
      .limit(1);
    if (!row) throw new NotFoundException('dashboard não encontrado');
    // row.workspaceId é a única fonte de tenant aqui (segurança multi-tenant).
    return this.renderWidgets(row, overrides, { publicView: true });
  }

  /**
   * Resolve cada widget em paralelo. Falha de um widget não derruba o dashboard:
   * retorna `{ error }` naquele widget. O workspace vem SEMPRE do registro do
   * dashboard (regra 1) — o resolver nunca aceita workspace do request.
   */
  private async renderWidgets(
    dash: Dashboard,
    overrides: DashboardOverrides,
    opts: { publicView?: boolean } = {},
  ) {
    const layout = dash.layout ?? EMPTY_LAYOUT;
    const global = layout.globalFilters;
    const workspaceId = dash.workspaceId;

    const widgets = await Promise.all(
      (layout.widgets ?? []).map((w) => this.resolveWidget(workspaceId, w, global, overrides)),
    );

    return {
      id: dash.id,
      name: dash.name,
      description: dash.description,
      is_public: dash.publicToken !== null,
      // O payload público não expõe workspace_id nem metadados de gestão.
      ...(opts.publicView ? {} : { public_token: dash.publicToken }),
      window: {
        start: overrides.start ?? global?.start ?? null,
        end: overrides.end ?? global?.end ?? null,
        period: overrides.period ?? global?.period ?? null,
      },
      widgets,
    };
  }

  private async resolveWidget(
    workspaceId: string,
    widget: DashboardWidget,
    global: DashboardLayout['globalFilters'],
    overrides: DashboardOverrides,
  ): Promise<Record<string, unknown>> {
    const base = { id: widget.id, type: widget.type, title: widget.title ?? null };
    try {
      const q = widget.query;
      const scope = this.scopeFor(global, q.filters, overrides);

      switch (q.kind) {
        case 'kpis': {
          const data = await this.metrics.nativeKpis(workspaceId, scope);
          return { ...base, kind: 'kpis', data };
        }
        case 'timeseries': {
          const metric = asMetric(q.metric);
          const gran: Granularity = q.granularity ?? 'day';
          const data = await this.metrics.timeseries(workspaceId, metric, gran, scope);
          return { ...base, kind: 'timeseries', data };
        }
        case 'breakdown': {
          const metric = asMetric(q.metric);
          const dimension = asDimension(q.dimension);
          const limit = q.limit ?? 20;
          const data = await this.metrics.breakdown(workspaceId, metric, dimension, limit, scope);
          return { ...base, kind: 'breakdown', data };
        }
        case 'custom_kpi': {
          // Carrega o KPI salvo (mesmo workspace) e avalia com o segmento mesclado.
          const view = await this.kpis.get(workspaceId, q.kpi_ref);
          const merged: MetricScope = {
            ...scope,
            period: scope.period ?? view.filters?.period,
            segment: { ...segmentFromFilters(view.filters), ...scope.segment },
          };
          const data = await this.metrics.evaluateFormula(workspaceId, view.formula, merged);
          return { ...base, kind: 'custom_kpi', kpi_ref: q.kpi_ref, name: view.name, data };
        }
        default: {
          return { ...base, error: 'tipo de query de widget desconhecido' };
        }
      }
    } catch (err) {
      this.logger.warn(`widget ${widget.id} falhou: ${(err as Error).message}`);
      return { ...base, error: (err as Error).message };
    }
  }

  /**
   * Mescla janela + segmento. Precedência de segmento: global < widget. Janela:
   * override do request > widget.period > global.start/end/period.
   */
  private scopeFor(
    global: DashboardLayout['globalFilters'],
    widgetFilters: KpiFilters | undefined,
    overrides: DashboardOverrides,
  ): MetricScope {
    return {
      start: overrides.start ?? global?.start,
      end: overrides.end ?? global?.end,
      period: overrides.period ?? widgetFilters?.period ?? global?.period,
      segment: {
        ...segmentFromFilters(global),
        ...segmentFromFilters(widgetFilters),
      },
    };
  }

  // ─────────────────────── helpers ───────────────────────

  private async getOwned(workspaceId: string, id: string): Promise<Dashboard> {
    const [row] = await this.db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('dashboard não encontrado');
    return row;
  }
}

/** Valida (defensivo) que a métrica salva pertence à allowlist antes de virar SQL. */
function asMetric(m: string): MetricKey {
  if (Object.prototype.hasOwnProperty.call(METRIC_EXPRESSIONS, m)) return m as MetricKey;
  throw new NotFoundException(`métrica desconhecida: ${m}`);
}

function asDimension(d: string): SegmentKey {
  if (Object.prototype.hasOwnProperty.call(SEGMENT_COLUMNS, d)) return d as SegmentKey;
  throw new NotFoundException(`dimensão desconhecida: ${d}`);
}

function toDashboardView(r: Dashboard): DashboardView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    layout: r.layout ?? EMPTY_LAYOUT,
    is_public: r.publicToken !== null,
    public_token: r.publicToken,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
