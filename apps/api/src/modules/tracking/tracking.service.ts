import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { and, eq, desc, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `trackingLinks` é exportado por @truvo/db somente após o barrel
// `schema/index.ts` re-exportar `./tracking` na integração da onda M3 (ver openTODOs).
import { createDb, createClickHouse, trackingLinks, type Database, type ClickHouseClient, type TrackingLink } from '@truvo/db';
import type { CreateTrackingLinkDto, UpdateTrackingLinkDto } from './dto/tracking-link.dto';

/**
 * nanoid@5 é ESM puro e o apps/api compila para CommonJS. Um `import` estático (ou
 * `import()` rebaixado para `require` pelo tsc) quebraria em runtime — então fazemos
 * um import dinâmico REAL via Function, que o compilador não transpila.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  s: string,
) => Promise<{ nanoid: (size?: number) => string }>;

/** Formato de saída da API (snake_case) para um tracking link. */
export interface TrackingLinkView {
  id: string;
  code: string;
  destination_url: string;
  label: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  click_count: number;
  active: boolean;
  short_path: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private _db: Database | null = null;
  private _ch: ClickHouseClient | null = null;
  private _nanoid: ((size?: number) => string) | null = null;

  // ── infra lazy (erro claro se o env faltar; ClickHouse é best-effort) ──
  private db(): Database {
    if (!this._db) this._db = createDb(); // lança se DATABASE_URL ausente
    return this._db;
  }

  private clickhouse(): ClickHouseClient {
    if (!this._ch) this._ch = createClickHouse();
    return this._ch;
  }

  private async nano(size = 8): Promise<string> {
    if (!this._nanoid) this._nanoid = (await dynamicImport('nanoid')).nanoid;
    return this._nanoid(size);
  }

  // ─────────────────────────── CRUD ───────────────────────────

  async create(workspaceId: string, dto: CreateTrackingLinkDto): Promise<TrackingLinkView> {
    const db = this.db();
    const now = new Date();

    // Tenta o code informado; senão gera nanoid e re-tenta em caso de colisão.
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = dto.code ?? (await this.nano(8));
      const row = {
        id: ulid(),
        workspaceId,
        code,
        destinationUrl: dto.destination_url,
        label: dto.label ?? null,
        utmSource: dto.utm_source ?? null,
        utmMedium: dto.utm_medium ?? null,
        utmCampaign: dto.utm_campaign ?? null,
        utmContent: dto.utm_content ?? null,
        utmTerm: dto.utm_term ?? null,
        clickCount: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const [created] = await db.insert(trackingLinks).values(row).returning();
        return this.toView(created);
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          if (dto.code) throw new ConflictException(`code '${dto.code}' já está em uso`);
          continue; // code gerado colidiu — tenta outro
        }
        throw err;
      }
    }
    throw new ConflictException('não foi possível gerar um code único, tente novamente');
  }

  async list(workspaceId: string): Promise<TrackingLinkView[]> {
    const db = this.db();
    const rows = await db
      .select()
      .from(trackingLinks)
      .where(and(eq(trackingLinks.workspaceId, workspaceId), eq(trackingLinks.active, true)))
      .orderBy(desc(trackingLinks.createdAt));
    return rows.map((r) => this.toView(r));
  }

  async get(workspaceId: string, id: string): Promise<TrackingLinkView> {
    return this.toView(await this.getOwned(workspaceId, id));
  }

  async update(workspaceId: string, id: string, dto: UpdateTrackingLinkDto): Promise<TrackingLinkView> {
    const db = this.db();
    await this.getOwned(workspaceId, id); // garante posse (regra 1)

    const patch: Partial<TrackingLink> = { updatedAt: new Date() };
    if (dto.destination_url !== undefined) patch.destinationUrl = dto.destination_url;
    if (dto.label !== undefined) patch.label = dto.label ?? null;
    if (dto.utm_source !== undefined) patch.utmSource = dto.utm_source ?? null;
    if (dto.utm_medium !== undefined) patch.utmMedium = dto.utm_medium ?? null;
    if (dto.utm_campaign !== undefined) patch.utmCampaign = dto.utm_campaign ?? null;
    if (dto.utm_content !== undefined) patch.utmContent = dto.utm_content ?? null;
    if (dto.utm_term !== undefined) patch.utmTerm = dto.utm_term ?? null;
    if (dto.active !== undefined) patch.active = dto.active;

    try {
      const [updated] = await db
        .update(trackingLinks)
        .set(patch)
        .where(and(eq(trackingLinks.id, id), eq(trackingLinks.workspaceId, workspaceId)))
        .returning();
      return this.toView(updated);
    } catch (err) {
      if (dto.code !== undefined && this.isUniqueViolation(err)) {
        throw new ConflictException(`code '${dto.code}' já está em uso`);
      }
      throw err;
    }
  }

  /** DELETE = soft-delete (active=false): `/c/:code` deixa de resolver, histórico preservado. */
  async remove(workspaceId: string, id: string): Promise<{ id: string; deleted: true }> {
    const db = this.db();
    const [row] = await db
      .update(trackingLinks)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(trackingLinks.id, id), eq(trackingLinks.workspaceId, workspaceId)))
      .returning({ id: trackingLinks.id });
    if (!row) throw new NotFoundException('tracking link não encontrado');
    return { id: row.id, deleted: true };
  }

  // ─────────────────────────── Stats ───────────────────────────

  /**
   * Stats por link: cliques (Postgres, autoritativo), sessões e conversões (ClickHouse,
   * eventos com click_id do link e is_bot=0 — regra 11). ClickHouse é best-effort:
   * se indisponível em dev, retorna 0 sem quebrar o endpoint.
   */
  async stats(workspaceId: string, id: string) {
    const link = await this.getOwned(workspaceId, id);
    const prefix = clickIdPrefix(link.code);

    let sessions = 0;
    let conversions = 0;
    let unique_sessions_bot_filtered = true;

    try {
      const ch = this.clickhouse();
      const rs = await ch.query({
        query: `
          SELECT
            uniqExact(session_id)                          AS sessions,
            countIf(event_name = 'purchase')               AS conversions
          FROM events
          WHERE workspace_id = {ws:String}
            AND is_bot = 0
            AND startsWith(click_id, {prefix:String})`,
        query_params: { ws: workspaceId, prefix },
        format: 'JSONEachRow',
      });
      const out = await rs.json<{ sessions: string | number; conversions: string | number }>();
      if (out[0]) {
        sessions = Number(out[0].sessions) || 0;
        conversions = Number(out[0].conversions) || 0;
      }
    } catch (err) {
      // TODO(live): ClickHouse pode não estar no ar em dev, ou a tabela `events` (M2)
      // ainda não existir. Degrada para 0 e sinaliza no payload.
      unique_sessions_bot_filtered = false;
      this.logger.warn(`stats: ClickHouse indisponível (${(err as Error).message})`);
    }

    return {
      link_id: link.id,
      code: link.code,
      clicks: link.clickCount,
      sessions,
      conversions,
      conversion_rate: sessions > 0 ? Number(((conversions / sessions) * 100).toFixed(2)) : 0,
      clickhouse_available: unique_sessions_bot_filtered,
    };
  }

  // ───────────────────── Redirect público /c/:code ─────────────────────

  async resolveByCode(code: string): Promise<TrackingLink | null> {
    const db = this.db();
    const [row] = await db
      .select()
      .from(trackingLinks)
      .where(and(eq(trackingLinks.code, code), eq(trackingLinks.active, true)))
      .limit(1);
    return row ?? null;
  }

  /** click_id determinístico por link: `clk_<code>.<rand>` → stats filtram por prefixo. */
  async newClickId(code: string): Promise<string> {
    return `${clickIdPrefix(code)}${await this.nano(16)}`;
  }

  /** Incremento do contador (regra: hot-path do redirect chama fire-and-forget). */
  async incrementClicks(id: string): Promise<void> {
    const db = this.db();
    await db
      .update(trackingLinks)
      .set({ clickCount: sql`${trackingLinks.clickCount} + 1`, updatedAt: new Date() })
      .where(eq(trackingLinks.id, id));
  }

  /**
   * Registra o clique no ClickHouse (série temporal). Best-effort — NÃO grava IP bruto
   * (regra 5): geo é enriquecido no consumer. Chamado fire-and-forget pelo redirect.
   */
  async logClick(params: {
    clickId: string;
    link: TrackingLink;
    referrer?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      const ch = this.clickhouse();
      await ch.insert({
        table: 'link_clicks',
        values: [
          {
            click_id: params.clickId,
            workspace_id: params.link.workspaceId,
            link_id: params.link.id,
            code: params.link.code,
            referrer: params.referrer ?? '',
            user_agent: params.userAgent ?? '',
            utm_source: params.link.utmSource ?? '',
            utm_medium: params.link.utmMedium ?? '',
            utm_campaign: params.link.utmCampaign ?? '',
          },
        ],
        format: 'JSONEachRow',
      });
    } catch (err) {
      // TODO(live): ClickHouse pode não estar no ar em dev — o contador do Postgres
      // permanece autoritativo, então apenas logamos.
      this.logger.debug(`logClick: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────── helpers ───────────────────────────

  private async getOwned(workspaceId: string, id: string): Promise<TrackingLink> {
    const db = this.db();
    const [row] = await db
      .select()
      .from(trackingLinks)
      .where(and(eq(trackingLinks.id, id), eq(trackingLinks.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('tracking link não encontrado');
    return row;
  }

  private isUniqueViolation(err: unknown): boolean {
    // postgres-js expõe o SQLSTATE em err.code; 23505 = unique_violation.
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
  }

  private toView(r: TrackingLink): TrackingLinkView {
    return {
      id: r.id,
      code: r.code,
      destination_url: r.destinationUrl,
      label: r.label,
      utm_source: r.utmSource,
      utm_medium: r.utmMedium,
      utm_campaign: r.utmCampaign,
      utm_content: r.utmContent,
      utm_term: r.utmTerm,
      click_count: r.clickCount,
      active: r.active,
      short_path: `/c/${r.code}`,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }
}

/** Prefixo de click_id por link. `.` não pertence ao alfabeto do nanoid → delimitador seguro. */
export function clickIdPrefix(code: string): string {
  return `clk_${code}.`;
}
