import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `kpiDefinitions` só existe em @truvo/db após o barrel
// `schema/index.ts` re-exportar `./metrics` (ver StructuredOutput.schemaExports).
import {
  kpiDefinitions,
  type KpiDefinition,
  type KpiFilters,
  type KpiFormula,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { MetricsService, type MetricScope } from './metrics.service';
import { SEGMENT_KEYS, type SegmentKey } from './metrics.constants';
import type { CreateKpiDto, UpdateKpiDto } from './dto/kpi.dto';

/** Overrides de janela ao avaliar um KPI (request > filtros salvos). */
export interface KpiEvalOverrides {
  start?: string;
  end?: string;
  period?: string;
}

/** View pública (snake_case) de um KPI. */
export interface KpiView {
  id: string;
  name: string;
  description: string | null;
  formula: KpiFormula;
  filters: KpiFilters;
  segment_by: string[];
  created_at: string;
  updated_at: string;
}

/** Extrai o subconjunto de segmento (allowlist) de um objeto de filtros salvo. */
export function segmentFromFilters(
  filters: KpiFilters | undefined,
): Partial<Record<SegmentKey, string | undefined>> {
  const seg: Partial<Record<SegmentKey, string | undefined>> = {};
  if (!filters) return seg;
  for (const key of SEGMENT_KEYS) {
    const v = (filters as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) seg[key] = v.trim();
  }
  return seg;
}

@Injectable()
export class KpisService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metrics: MetricsService,
  ) {}

  // ─────────────────────────── CRUD ───────────────────────────

  async create(workspaceId: string, userId: string | undefined, dto: CreateKpiDto): Promise<KpiView> {
    const now = new Date();
    const [row] = await this.db
      .insert(kpiDefinitions)
      .values({
        id: ulid(),
        workspaceId,
        name: dto.name,
        description: dto.description ?? null,
        formula: dto.formula,
        filters: dto.filters ?? {},
        segmentBy: dto.segment_by ?? [],
        createdBy: userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('falha ao criar KPI');
    return toKpiView(row);
  }

  async list(workspaceId: string): Promise<KpiView[]> {
    const rows = await this.db
      .select()
      .from(kpiDefinitions)
      .where(eq(kpiDefinitions.workspaceId, workspaceId))
      .orderBy(desc(kpiDefinitions.createdAt));
    return rows.map(toKpiView);
  }

  async get(workspaceId: string, id: string): Promise<KpiView> {
    return toKpiView(await this.getOwned(workspaceId, id));
  }

  async update(workspaceId: string, id: string, dto: UpdateKpiDto): Promise<KpiView> {
    await this.getOwned(workspaceId, id); // garante posse (regra 1)

    const patch: Partial<KpiDefinition> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description ?? null;
    if (dto.formula !== undefined) patch.formula = dto.formula;
    if (dto.filters !== undefined) patch.filters = dto.filters;
    if (dto.segment_by !== undefined) patch.segmentBy = dto.segment_by;

    const [row] = await this.db
      .update(kpiDefinitions)
      .set(patch)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new NotFoundException('KPI não encontrado');
    return toKpiView(row);
  }

  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    const [row] = await this.db
      .delete(kpiDefinitions)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.workspaceId, workspaceId)))
      .returning({ id: kpiDefinitions.id });
    if (!row) throw new NotFoundException('KPI não encontrado');
    return { id: row.id, deleted: true };
  }

  // ─────────────────────── Avaliação ───────────────────────

  /** Avalia um KPI salvo (por id) com overrides de janela do request. */
  async evaluate(workspaceId: string, id: string, overrides: KpiEvalOverrides = {}) {
    const def = await this.getOwned(workspaceId, id);
    const result = await this.evaluateDefinition(workspaceId, def.formula, def.filters, overrides);
    return { id: def.id, name: def.name, ...result };
  }

  /**
   * Avalia uma fórmula + filtros salvos, aplicando overrides de janela. Reusado
   * pelo resolver de widgets (custom_kpi). O segmento vem dos filtros salvos; a
   * janela do request tem prioridade sobre o `period` salvo.
   */
  async evaluateDefinition(
    workspaceId: string,
    formula: KpiFormula,
    filters: KpiFilters | undefined,
    overrides: KpiEvalOverrides = {},
  ) {
    const scope: MetricScope = {
      start: overrides.start,
      end: overrides.end,
      period: overrides.period ?? filters?.period,
      segment: segmentFromFilters(filters),
    };
    return this.metrics.evaluateFormula(workspaceId, formula, scope);
  }

  // ─────────────────────── helpers ───────────────────────

  private async getOwned(workspaceId: string, id: string): Promise<KpiDefinition> {
    const [row] = await this.db
      .select()
      .from(kpiDefinitions)
      .where(and(eq(kpiDefinitions.id, id), eq(kpiDefinitions.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('KPI não encontrado');
    return row;
  }
}

function toKpiView(r: KpiDefinition): KpiView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    formula: r.formula,
    filters: r.filters,
    segment_by: r.segmentBy,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
