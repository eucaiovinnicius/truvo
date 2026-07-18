import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `funnels` (tabela) e os tipos `Funnel`/`FunnelStep`/`FunnelAlert`
// são expostos por @truvo/db só após o barrel `schema/index.ts` re-exportar `./funnels`
// na integração da onda M5 (ver schemaExports/openTODOs) — mesmo padrão do M3/M4.
import { funnels, type Funnel, type FunnelAlert, type FunnelStep } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { FunnelCalcService } from './funnel-calc.service';
import { FunnelAlertsService } from './funnel-alerts.service';
import type {
  CreateFunnelDto,
  DropoffQueryDto,
  FunnelStepInput,
  StatsQueryDto,
  UpdateFunnelDto,
} from './dto/funnel.dto';

/** Saída da API (snake_case) para um funil. */
export interface FunnelView {
  id: string;
  name: string;
  status: 'active' | 'archived' | 'draft';
  attribution_window_days: number;
  steps: FunnelStep[];
  alert: FunnelAlert;
  sparkline: number[];
  created_at: string;
  updated_at: string;
}

const DEFAULT_ALERT: FunnelAlert = { enabled: false, min_overall_conversion_rate: 0 };

@Injectable()
export class FunnelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly calc: FunnelCalcService,
    private readonly alerts: FunnelAlertsService,
  ) {}

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(workspaceId: string, dto: CreateFunnelDto): Promise<FunnelView> {
    const now = new Date();
    const row = {
      id: `fnl_${ulid()}`,
      workspaceId,
      name: dto.name,
      status: dto.status,
      attributionWindowDays: dto.attribution_window_days,
      steps: normalizeSteps(dto.steps),
      alert: dto.alert ?? DEFAULT_ALERT,
      sparkline: [] as number[],
      createdAt: now,
      updatedAt: now,
    };
    const [created] = await this.db.insert(funnels).values(row).returning();
    return toView(created ?? row);
  }

  async list(workspaceId: string): Promise<FunnelView[]> {
    const rows = await this.db
      .select()
      .from(funnels)
      .where(eq(funnels.workspaceId, workspaceId))
      .orderBy(desc(funnels.createdAt));
    return rows.map(toView);
  }

  async get(workspaceId: string, id: string): Promise<FunnelView> {
    return toView(await this.getOwned(workspaceId, id));
  }

  async update(workspaceId: string, id: string, dto: UpdateFunnelDto): Promise<FunnelView> {
    await this.getOwned(workspaceId, id); // garante posse (regra 1)

    const patch: Partial<Funnel> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.attribution_window_days !== undefined) patch.attributionWindowDays = dto.attribution_window_days;
    if (dto.steps !== undefined) patch.steps = normalizeSteps(dto.steps);
    if (dto.alert !== undefined) patch.alert = dto.alert;

    const [updated] = await this.db
      .update(funnels)
      .set(patch)
      .where(and(eq(funnels.id, id), eq(funnels.workspaceId, workspaceId)))
      .returning();
    if (!updated) throw new NotFoundException('funil não encontrado');
    return toView(updated);
  }

  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    const [row] = await this.db
      .delete(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.workspaceId, workspaceId)))
      .returning({ id: funnels.id });
    if (!row) throw new NotFoundException('funil não encontrado');
    return { id: row.id, deleted: true };
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  /** GET /v1/funnels/:id/stats — métricas + avaliação de alerta (não dispara aqui). */
  async stats(workspaceId: string, id: string, query: StatsQueryDto) {
    const funnel = await this.getOwned(workspaceId, id);
    const { compare, ...filters } = query;
    const stats = await this.calc.stats(workspaceId, funnel, filters, Boolean(compare));
    const alertStatus = this.alerts.evaluate(funnel, stats.overall_conversion_rate);
    return { ...stats, alert_status: alertStatus };
  }

  /** GET /v1/funnels/:id/preview — contagem últimos 30d (builder). */
  async preview(workspaceId: string, id: string) {
    const funnel = await this.getOwned(workspaceId, id);
    return this.calc.preview(workspaceId, funnel);
  }

  /** GET /v1/funnels/:id/dropoff/:stepId — usuários que pararam no step. */
  async dropoff(workspaceId: string, id: string, stepId: string, query: DropoffQueryDto) {
    const funnel = await this.getOwned(workspaceId, id);
    const stepIndex = funnel.steps.findIndex((s) => s.step_id === stepId);
    if (stepIndex < 0) throw new NotFoundException(`step '${stepId}' não existe neste funil`);

    const { limit, format, ...filters } = query;
    const result = await this.calc.dropoff(workspaceId, funnel, stepIndex + 1, filters, limit);
    const step = funnel.steps[stepIndex];
    return {
      funnel_id: funnel.id,
      step: step ? { step_id: step.step_id, name: step.name, event: step.event } : null,
      format,
      ...result,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async getOwned(workspaceId: string, id: string): Promise<Funnel> {
    const [row] = await this.db
      .select()
      .from(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('funil não encontrado');
    return row;
  }
}

/** Garante `step_id` (default `s<n>`) e `conditions` presente em cada step. */
function normalizeSteps(steps: FunnelStepInput[]): FunnelStep[] {
  return steps.map((s, i) => ({
    step_id: s.step_id ?? `s${i + 1}`,
    name: s.name,
    event: s.event,
    conditions: s.conditions ?? {},
  }));
}

function toView(f: Funnel): FunnelView {
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    attribution_window_days: f.attributionWindowDays,
    steps: f.steps ?? [],
    alert: f.alert ?? DEFAULT_ALERT,
    sparkline: f.sparkline ?? [],
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  };
}
