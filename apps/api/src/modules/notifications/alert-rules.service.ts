import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { alertRules, type AlertRule } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import type { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/notifications.dto';

/** Regra de alerta serializada para o cliente. */
export interface AlertRuleView {
  id: string;
  type: string;
  category: string;
  name: string;
  enabled: boolean;
  severity: string;
  channels: string[];
  config: Record<string, unknown>;
  dedup_window_minutes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * M12 — CRUD de regras de alerta por workspace (PRD §7 M12). O NotificationService
 * lê estas regras no dispatch (enabled/canais/severidade/janela de dedup).
 */
@Injectable()
export class AlertRulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(workspaceId: string): Promise<AlertRuleView[]> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(eq(alertRules.workspaceId, workspaceId))
      .orderBy(desc(alertRules.createdAt));
    return rows.map(serialize);
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateAlertRuleDto,
  ): Promise<AlertRuleView> {
    const now = new Date();
    const id = `alr_${ulid()}`;
    const rows = await this.db
      .insert(alertRules)
      .values({
        id,
        workspaceId,
        type: dto.type,
        category: dto.category,
        name: dto.name,
        enabled: dto.enabled,
        severity: dto.severity,
        channels: dto.channels,
        config: dto.config,
        dedupWindowMinutes: dto.dedup_window_minutes,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new NotFoundException('Falha ao criar regra');
    return serialize(row);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateAlertRuleDto,
  ): Promise<AlertRuleView> {
    const patch: Partial<typeof alertRules.$inferInsert> = { updatedAt: new Date() };
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.severity !== undefined) patch.severity = dto.severity;
    if (dto.channels !== undefined) patch.channels = dto.channels;
    if (dto.config !== undefined) patch.config = dto.config;
    if (dto.dedup_window_minutes !== undefined)
      patch.dedupWindowMinutes = dto.dedup_window_minutes;

    const rows = await this.db
      .update(alertRules)
      .set(patch)
      .where(and(eq(alertRules.id, id), eq(alertRules.workspaceId, workspaceId)))
      .returning();
    const row = rows[0];
    if (!row) throw new NotFoundException('Regra não encontrada');
    return serialize(row);
  }

  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    const rows = await this.db
      .delete(alertRules)
      .where(and(eq(alertRules.id, id), eq(alertRules.workspaceId, workspaceId)))
      .returning({ id: alertRules.id });
    if (!rows[0]) throw new NotFoundException('Regra não encontrada');
    return { id, deleted: true };
  }
}

function serialize(r: AlertRule): AlertRuleView {
  return {
    id: r.id,
    type: r.type,
    category: r.category,
    name: r.name,
    enabled: r.enabled,
    severity: r.severity,
    channels: r.channels ?? [],
    config: r.config ?? {},
    dedup_window_minutes: r.dedupWindowMinutes,
    created_by: r.createdBy ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
