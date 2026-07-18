import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import {
  insightShares,
  insightVersions,
  insights,
  type ExplorerQuerySpec,
  type Insight,
  type InsightKind,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { ExplorerService, type ExecResult } from './explorer.service';
import { explorerQuerySpecSchema, asStoredSpec, type ExplorerQuerySpecInput } from './compiler/spec';
import { validateGuardedSql } from './compiler/sql-allowlist';
import type {
  CreateInsightDto,
  CreateShareDto,
  UpdateInsightDto,
} from './dto/insight.dto';

/**
 * M16 — InsightsService: biblioteca self-serve (CRUD), versionamento imutável,
 * restore, compartilhamento read-only por token e execução (/run) de insights
 * salvos (visual ou SQL). Regra 1: TODA operação é escopada por workspace_id.
 *
 * O token público carrega SÓ o insight_id; o workspace_id é resolvido SERVER-SIDE
 * pelo dono do share — NUNCA a partir do request (segurança multi-tenant, PRD §7 M16).
 */
@Injectable()
export class InsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly explorer: ExplorerService,
  ) {}

  // ─────────────────────────── CRUD ───────────────────────────

  async create(workspaceId: string, userId: string | undefined, dto: CreateInsightDto) {
    const { kind, insightType, spec, sqlText } = this.normalizeContent(dto);
    const now = new Date();
    const id = `ins_${ulid()}`;

    const [row] = await this.db
      .insert(insights)
      .values({
        id,
        workspaceId,
        kind,
        insightType,
        name: dto.name,
        description: dto.description ?? null,
        spec: spec ?? null,
        sqlText: sqlText ?? null,
        ownerId: userId ?? null,
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('falha ao criar insight');

    await this.snapshotVersion(row, 1, userId);
    return toInsightView(row);
  }

  async list(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(insights)
      .where(eq(insights.workspaceId, workspaceId))
      .orderBy(desc(insights.createdAt));
    return rows.map(toInsightView);
  }

  async get(workspaceId: string, id: string) {
    return toInsightView(await this.getOwned(workspaceId, id));
  }

  async update(
    workspaceId: string,
    userId: string | undefined,
    id: string,
    dto: UpdateInsightDto,
  ) {
    const current = await this.getOwned(workspaceId, id);

    // Conteúdo novo (se enviado) revalidado contra o mesmo kind do insight.
    let spec = current.spec;
    let sqlText = current.sqlText;
    let insightType = current.insightType;
    if (dto.spec !== undefined || dto.sqlText !== undefined) {
      const content = this.normalizeContent({
        kind: current.kind,
        name: current.name,
        spec: dto.spec,
        sqlText: dto.sqlText,
      });
      spec = content.spec ?? null;
      sqlText = content.sqlText ?? null;
      insightType = content.insightType;
    }

    const nextVersion = current.currentVersion + 1;
    const [row] = await this.db
      .update(insights)
      .set({
        name: dto.name ?? current.name,
        description: dto.description === undefined ? current.description : dto.description,
        spec,
        sqlText,
        insightType,
        currentVersion: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new NotFoundException('insight não encontrado');

    await this.snapshotVersion(row, nextVersion, userId);
    return toInsightView(row);
  }

  async remove(workspaceId: string, id: string) {
    const [row] = await this.db
      .delete(insights)
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
      .returning({ id: insights.id });
    if (!row) throw new NotFoundException('insight não encontrado');
    // Versões e shares ficam órfãos por design (auditoria); limpeza é job (TODO(live)).
    await this.db.delete(insightShares).where(eq(insightShares.insightId, id));
    return { id: row.id, deleted: true as const };
  }

  // ─────────────────────────── execução ───────────────────────────

  /** POST /v1/insights/:id/run — roda o insight salvo (dono autenticado). */
  async run(workspaceId: string, userId: string | undefined, id: string): Promise<ExecResult> {
    const row = await this.getOwned(workspaceId, id);
    return this.execute(row, userId);
  }

  private async execute(row: Insight, userId: string | undefined): Promise<ExecResult> {
    if (row.kind === 'sql') {
      if (!row.sqlText) throw new BadRequestException('insight SQL sem conteúdo');
      return this.explorer.runGuardedSql(row.workspaceId, userId, row.sqlText);
    }
    if (!row.spec) throw new BadRequestException('insight visual sem spec');
    // Revalida o spec armazenado antes de compilar (defesa: dado pode estar velho).
    const parsed = explorerQuerySpecSchema.safeParse(row.spec);
    if (!parsed.success) {
      throw new BadRequestException('spec do insight inválido; reeditar');
    }
    return this.explorer.executeSpec(row.workspaceId, userId, parsed.data, 'run', row.id);
  }

  // ─────────────────────────── versionamento ───────────────────────────

  async listVersions(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id); // valida ownership/tenant
    const rows = await this.db
      .select()
      .from(insightVersions)
      .where(
        and(eq(insightVersions.insightId, id), eq(insightVersions.workspaceId, workspaceId)),
      )
      .orderBy(desc(insightVersions.version));
    return rows.map((v) => ({
      id: v.id,
      version: v.version,
      kind: v.kind,
      insight_type: v.insightType,
      author_id: v.authorId,
      created_at: v.createdAt.toISOString(),
    }));
  }

  /** POST /v1/insights/:id/restore/:versionId — restaura como uma NOVA versão. */
  async restore(workspaceId: string, userId: string | undefined, id: string, versionId: string) {
    const current = await this.getOwned(workspaceId, id);
    const [version] = await this.db
      .select()
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.id, versionId),
          eq(insightVersions.insightId, id),
          eq(insightVersions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!version) throw new NotFoundException('versão não encontrada');

    const nextVersion = current.currentVersion + 1;
    const [row] = await this.db
      .update(insights)
      .set({
        kind: version.kind,
        insightType: version.insightType,
        spec: version.spec ?? null,
        sqlText: version.sqlText ?? null,
        currentVersion: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new NotFoundException('insight não encontrado');

    await this.snapshotVersion(row, nextVersion, userId);
    return toInsightView(row);
  }

  private async snapshotVersion(row: Insight, version: number, userId: string | undefined) {
    await this.db.insert(insightVersions).values({
      id: `inv_${ulid()}`,
      insightId: row.id,
      workspaceId: row.workspaceId,
      version,
      kind: row.kind,
      insightType: row.insightType,
      spec: row.spec ?? null,
      sqlText: row.sqlText ?? null,
      authorId: userId ?? null,
      createdAt: new Date(),
    });
  }

  // ─────────────────────────── compartilhamento ───────────────────────────

  async createShare(
    workspaceId: string,
    userId: string | undefined,
    id: string,
    dto: CreateShareDto,
  ) {
    await this.getOwned(workspaceId, id); // valida ownership/tenant
    const token = `ish_${ulid()}${randomBytes(6).toString('hex')}`;
    const passwordHash = dto.password ? hashPassword(dto.password) : null;
    const expiresAt = dto.expires_at ? new Date(dto.expires_at) : null;

    const [row] = await this.db
      .insert(insightShares)
      .values({
        id: `shr_${ulid()}`,
        insightId: id,
        workspaceId,
        token,
        passwordHash,
        expiresAt,
        createdBy: userId ?? null,
        createdAt: new Date(),
      })
      .returning();
    if (!row) throw new Error('falha ao criar share');
    return {
      id: row.id,
      token: row.token,
      protected: passwordHash !== null,
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      url_path: `/v1/insights/public/${row.token}`,
    };
  }

  async deleteShare(workspaceId: string, id: string, shareId: string) {
    const [row] = await this.db
      .update(insightShares)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(insightShares.id, shareId),
          eq(insightShares.insightId, id),
          eq(insightShares.workspaceId, workspaceId),
        ),
      )
      .returning({ id: insightShares.id });
    if (!row) throw new NotFoundException('share não encontrado');
    return { id: row.id, revoked: true as const };
  }

  /**
   * GET /v1/insights/public/:token — resolução PÚBLICA read-only. O workspace é
   * resolvido SERVER-SIDE pelo share (row.workspaceId), NUNCA do request. Sem token
   * válido/ativo → 404. Senha (se houver) exigida. Não expõe o spec/SQL editável.
   */
  async resolvePublic(token: string, password: string | undefined) {
    const clean = token.trim();
    if (!clean) throw new NotFoundException('não encontrado');

    const [share] = await this.db
      .select()
      .from(insightShares)
      .where(eq(insightShares.token, clean))
      .limit(1);
    if (!share || share.revokedAt) throw new NotFoundException('não encontrado');
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('link expirado');
    }
    if (share.passwordHash) {
      if (!password || !verifyPassword(password, share.passwordHash)) {
        throw new ForbiddenException('senha inválida');
      }
    }

    // Tenant SEMPRE do share (regra 1) — nunca do request.
    const [row] = await this.db
      .select()
      .from(insights)
      .where(and(eq(insights.id, share.insightId), eq(insights.workspaceId, share.workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('não encontrado');

    // Execução read-only, sem usuário (público). Sem workspace do request.
    const data = await this.execute(row, undefined);
    return {
      insight: {
        id: row.id,
        name: row.name,
        description: row.description,
        kind: row.kind,
        insight_type: row.insightType,
      },
      data,
    };
  }

  // ─────────────────────────── helpers ───────────────────────────

  private async getOwned(workspaceId: string, id: string): Promise<Insight> {
    const [row] = await this.db
      .select()
      .from(insights)
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('insight não encontrado');
    return row;
  }

  /**
   * Valida e normaliza o conteúdo (spec visual ou SQL guardado) contra o `kind`.
   * Visual → parseia o spec (allowlist de forma) e extrai insight_type.
   * SQL → valida o allowlist sintático (AST) ANTES de aceitar salvar.
   */
  private normalizeContent(dto: {
    kind: InsightKind;
    name: string;
    spec?: unknown;
    sqlText?: string | null;
  }): {
    kind: InsightKind;
    insightType: string;
    spec?: ExplorerQuerySpec | null;
    sqlText?: string | null;
  } {
    if (dto.kind === 'sql') {
      const sql = (dto.sqlText ?? '').trim();
      if (!sql) throw new BadRequestException('insight SQL exige sql_text');
      const v = validateGuardedSql(sql);
      if (!v.ok) throw new BadRequestException(`SQL inválido: ${v.reason}`);
      return { kind: 'sql', insightType: 'sql', sqlText: sql, spec: null };
    }
    // visual
    const parsed = explorerQuerySpecSchema.safeParse(dto.spec);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'spec inválido', issues: parsed.error.flatten() });
    }
    const stored = asStoredSpec(parsed.data as ExplorerQuerySpecInput);
    return { kind: 'visual', insightType: parsed.data.insight_type, spec: stored, sqlText: null };
  }
}

// ─────────────────────────── serialização / senha ───────────────────────────

interface InsightView {
  id: string;
  name: string;
  description: string | null;
  kind: InsightKind;
  insight_type: string;
  spec: ExplorerQuerySpec | null;
  sql_text: string | null;
  current_version: number;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

function toInsightView(r: Insight): InsightView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    insight_type: r.insightType,
    spec: r.spec ?? null,
    sql_text: r.sqlText ?? null,
    current_version: r.currentVersion,
    owner_id: r.ownerId,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/**
 * Hash de senha do share (scrypt + salt). Formato: `scrypt$<saltHex>$<hashHex>`.
 * // TODO(live): unificar com o hashing de credenciais do M1 (argon2/bcrypt) e o
 * cofre de tokens de share (M6/M13/M16 — decisão pendente do PRD, item 6).
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'hex');
  const expected = Buffer.from(parts[2] ?? '', 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
