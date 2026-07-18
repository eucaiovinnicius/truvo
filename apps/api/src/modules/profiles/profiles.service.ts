import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `identityLinks`/`identityMerges` (M8) e `userProfiles`/
// `profileAccessLog` (M15) só existem em @truvo/db após o barrel `schema/index.ts`
// re-exportar `./identity` e `./profiles` — ver schemaExports/openTODOs.
import {
  identityLinks,
  identityMerges,
  profileAccessLog,
  type UserProfile,
  type ProfileAccessAction,
  type ProfileDevice,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import type { AuthUser } from '../auth/decorators';
import { getClickHouse } from './profiles.infra';
import { ProfileProjectionService, type ResolvedGraph, type ProfileConfidence } from './profile-projection.service';
import {
  buildJourneySql,
  buildTimelineSql,
  chTimestampToIso,
  decodeCursor,
  deriveChannel,
  encodeCursor,
  type TimelineRow,
  type TouchpointRow,
} from './profiles-sql';
import type {
  AttributionModel,
  JourneyQueryDto,
  ProfileSearchType,
  SearchQueryDto,
  TimelineQueryDto,
} from './dto/profiles.dto';

/**
 * Tipos de identificador do grafo (M8). Espelham `identifierTypeEnum` de
 * `schema/identity.ts` — mantidos como tupla local porque o valor RUNTIME do enum só
 * chega em @truvo/db após a integração do barrel (mesma convenção do IdentityModule).
 */
const IDENTIFIER_TYPES = [
  'click_id',
  'anonymous_id',
  'user_id',
  'email_hash',
  'phone_hash',
  'order_id',
] as const;
type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

const HEX64 = /^[a-f0-9]{64}$/i;

/** Grafo agrupado por tipo + metadados, montado de identity_links. */
interface GraphByType {
  exists: boolean;
  canonicalId: string;
  identified: boolean;
  firstSeen: Date | null;
  byType: Record<IdentifierType, string[]>;
}

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly projection: ProfileProjectionService,
  ) {}

  // ─────────────────────────────── busca ───────────────────────────────

  /**
   * GET /v1/profiles/search — resolve um dos 5 tipos de identificador → canonical_id
   * dentro do workspace (regra 1/20 — nunca cruza tenant). E-mail/telefone SÓ como
   * hash (regra 4): o cliente hasheia; recusamos e-mail em claro. Registra o acesso.
   */
  async search(workspaceId: string, dto: SearchQueryDto, actor: AuthUser) {
    const term = this.normalizeSearchTerm(dto.type, dto.q);
    const canonicalId = await this.resolveCanonical(workspaceId, term);

    // Auditamos a TENTATIVA (sempre), mas nunca gravamos o termo cru (só o tipo) —
    // metadata sem PII (regras 4/5/20).
    if (!canonicalId) {
      await this.logAccess(workspaceId, '', actor, 'search', { search_type: dto.type, found: false });
      return { query: { type: dto.type }, results: [] as ProfileCandidate[] };
    }

    const graph = await this.resolveGraph(workspaceId, canonicalId);
    const raw = await this.projection.loadRaw(workspaceId, canonicalId);
    const tombstoned = Boolean(raw?.tombstonedAt);

    await this.logAccess(workspaceId, canonicalId, actor, 'search', {
      search_type: dto.type,
      found: !tombstoned,
    });

    if (tombstoned) {
      return { query: { type: dto.type }, results: [] as ProfileCandidate[] };
    }

    const profile = await this.projection.getFresh(workspaceId, this.toResolvedGraph(graph));
    return {
      query: { type: dto.type },
      results: [this.toCandidate(canonicalId, graph, profile)],
    };
  }

  // ─────────────────────────── perfil consolidado ───────────────────────────

  /** GET /v1/profiles/:canonicalId — cabeçalho (identidade) + métricas + incerteza. */
  async getProfile(workspaceId: string, canonicalId: string, actor: AuthUser) {
    const graph = await this.resolveGraph(workspaceId, canonicalId);
    const raw = await this.projection.loadRaw(workspaceId, canonicalId);
    const exists = graph.exists && !raw?.tombstonedAt;

    await this.logAccess(workspaceId, canonicalId, actor, 'view_profile', { found: exists });
    if (!exists) throw new NotFoundException('perfil não encontrado neste workspace');

    const resolved = this.toResolvedGraph(graph);
    const profile = await this.projection.getFresh(workspaceId, resolved);
    const confidence = await this.projection.confidence(
      workspaceId,
      profile?.firstSeenAt ?? graph.firstSeen,
      profile?.lastSeenAt ?? null,
    );

    return this.toProfileView(canonicalId, graph, profile, confidence);
  }

  // ───────────────────────────────── timeline ─────────────────────────────────

  /**
   * GET /v1/profiles/:canonicalId/timeline — eventos da pessoa (DESC), filtráveis e
   * paginados por cursor `(timestamp,event_id)`. Lê a `events` do ClickHouse com
   * is_bot = 0 (regra 11) e devolve contexto IP-free (regra 5). Agrupável por dia.
   */
  async getTimeline(workspaceId: string, canonicalId: string, dto: TimelineQueryDto, actor: AuthUser) {
    const graph = await this.resolveGraph(workspaceId, canonicalId);
    const raw = await this.projection.loadRaw(workspaceId, canonicalId);
    const exists = graph.exists && !raw?.tombstonedAt;

    await this.logAccess(workspaceId, canonicalId, actor, 'view_timeline', {
      found: exists,
      filters: this.timelineFilterMeta(dto),
    });
    if (!exists) throw new NotFoundException('perfil não encontrado neste workspace');

    const actorIds = {
      userIds: graph.byType.user_id,
      anonymousIds: graph.byType.anonymous_id,
    };

    // Sem identificadores de evento → nada a mostrar (perfil só-order/click, p.ex.).
    if (actorIds.userIds.length === 0 && actorIds.anonymousIds.length === 0) {
      return this.emptyTimeline(canonicalId, dto, true);
    }

    const cursor = decodeCursor(dto.cursor);
    const { sql, params } = buildTimelineSql({
      workspaceId,
      actor: actorIds,
      filters: {
        start: dto.start,
        end: dto.end,
        event_name: dto.event_name,
        source: dto.source,
        device_type: dto.device_type,
      },
      cursor,
      limit: dto.limit + 1, // +1 sonda a próxima página.
    });

    let rows: TimelineRow[] = [];
    try {
      const ch = getClickHouse();
      const rs = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
      rows = await rs.json<TimelineRow>();
    } catch (err) {
      this.logger.warn(`timeline: ClickHouse indisponível (${(err as Error).message})`);
      return this.emptyTimeline(canonicalId, dto, false);
    }

    const hasMore = rows.length > dto.limit;
    const pageRows = hasMore ? rows.slice(0, dto.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ t: last.event_ts, id: last.event_id }) : null;

    const events = pageRows.map((r) => toTimelineEvent(r));

    return {
      canonical_id: canonicalId,
      clickhouse_available: true,
      count: events.length,
      next_cursor: nextCursor,
      ...(dto.group_by === 'day' ? { groups: groupByDay(events) } : { events }),
    };
  }

  // ─────────────────────────────── identidades ───────────────────────────────

  /**
   * GET /v1/profiles/:canonicalId/identities — identificadores fundidos por tipo +
   * devices + histórico de merges (M8). Só leitura (o M15 nunca edita o grafo).
   */
  async getIdentities(workspaceId: string, canonicalId: string, actor: AuthUser) {
    const graph = await this.resolveGraph(workspaceId, canonicalId);
    const raw = await this.projection.loadRaw(workspaceId, canonicalId);
    const exists = graph.exists && !raw?.tombstonedAt;

    await this.logAccess(workspaceId, canonicalId, actor, 'view_identities', { found: exists });
    if (!exists) throw new NotFoundException('perfil não encontrado neste workspace');

    const profile = await this.projection.getFresh(workspaceId, this.toResolvedGraph(graph));

    const merges = await this.db
      .select()
      .from(identityMerges)
      .where(and(eq(identityMerges.workspaceId, workspaceId), eq(identityMerges.canonicalId, canonicalId)))
      .orderBy(desc(identityMerges.at))
      .limit(100);

    return {
      canonical_id: canonicalId,
      status: graph.identified ? 'identified' : 'anonymous',
      // e-mail/telefone SÓ como hash (regra 4).
      email_hashes: graph.byType.email_hash,
      phone_hashes: graph.byType.phone_hash,
      identity: {
        anonymous_ids: graph.byType.anonymous_id,
        user_ids: graph.byType.user_id,
        order_ids: graph.byType.order_id,
        click_ids: graph.byType.click_id,
        devices: (profile?.devices ?? []) as ProfileDevice[],
      },
      // Aviso honesto: sem stitch cross-device quando não há identidade forte.
      cross_device_stitched: graph.identified,
      merges: merges.map((m) => ({
        id: m.id,
        canonical_id: m.canonicalId,
        merged_from: m.mergedFrom,
        reason: m.reason,
        at: m.at.toISOString(),
      })),
    };
  }

  // ─────────────────────────────── jornada ───────────────────────────────

  /**
   * GET /v1/profiles/:canonicalId/journey — jornada de conversão da pessoa: os
   * touchpoints do M7 (ClickHouse) renderizados por pedido, com o crédito do modelo
   * selecionado. RENDERIZAÇÃO — não é a fonte autoritativa de atribuição (essa é o
   * M7). // TODO(live): quando o Attribution Engine (M7) existir, ler o crédito
   * autoritativo dele em vez de derivar aqui (fronteira PRD §7 M15 / M16 / M17).
   */
  async getJourney(workspaceId: string, canonicalId: string, dto: JourneyQueryDto, actor: AuthUser) {
    const graph = await this.resolveGraph(workspaceId, canonicalId);
    const raw = await this.projection.loadRaw(workspaceId, canonicalId);
    const exists = graph.exists && !raw?.tombstonedAt;

    await this.logAccess(workspaceId, canonicalId, actor, 'view_journey', {
      found: exists,
      model: dto.model,
      window: dto.window,
    });
    if (!exists) throw new NotFoundException('perfil não encontrado neste workspace');

    let touchpoints: TouchpointRow[] = [];
    let clickhouseAvailable = true;
    try {
      const ch = getClickHouse();
      const { sql, params } = buildJourneySql(workspaceId, canonicalId);
      const rs = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
      touchpoints = await rs.json<TouchpointRow>();
    } catch (err) {
      clickhouseAvailable = false;
      this.logger.warn(`journey: ClickHouse indisponível (${(err as Error).message})`);
    }

    const paths = buildJourneyPaths(touchpoints, dto.model, dto.window);
    return {
      canonical_id: canonicalId,
      model: dto.model,
      attribution_window_days: dto.window,
      clickhouse_available: clickhouseAvailable,
      credit_source: 'rendered', // não autoritativo — ver TODO(live)/M7.
      conversions_count: paths.length,
      paths,
    };
  }

  // ─────────────────────────── helpers de identidade ───────────────────────────

  /** Normaliza o termo de busca conforme o tipo (regra 4/11: mesma normalização da ingestão). */
  private normalizeSearchTerm(type: ProfileSearchType, q: string): string {
    const value = q.trim();
    if (type === 'email_hash' || type === 'phone_hash') {
      if (value.includes('@')) {
        throw new BadRequestException(
          'envie o hash SHA-256 do e-mail (feito no cliente), nunca o e-mail em claro (regra 4)',
        );
      }
      const hash = value.toLowerCase();
      if (!HEX64.test(hash)) {
        throw new BadRequestException(`${type} deve ser um SHA-256 hex (64 caracteres)`);
      }
      return hash;
    }
    return value; // user_id | anonymous_id | order_id → as-is
  }

  /** Resolve identificador → canonical_id (identity_links, M8). Regra 1/20. */
  private async resolveCanonical(workspaceId: string, identifier: string): Promise<string | null> {
    const [row] = await this.db
      .select({ canonicalId: identityLinks.canonicalId })
      .from(identityLinks)
      .where(and(eq(identityLinks.workspaceId, workspaceId), eq(identityLinks.identifier, identifier)))
      .limit(1);
    return row?.canonicalId ?? null;
  }

  /** Monta o grafo (agrupado por tipo) de um canonical dentro do workspace (regra 1). */
  private async resolveGraph(workspaceId: string, canonicalId: string): Promise<GraphByType> {
    const rows = await this.db
      .select({
        identifier: identityLinks.identifier,
        identifierType: identityLinks.identifierType,
        firstSeen: identityLinks.firstSeen,
      })
      .from(identityLinks)
      .where(and(eq(identityLinks.workspaceId, workspaceId), eq(identityLinks.canonicalId, canonicalId)))
      .orderBy(identityLinks.firstSeen);

    const byType = emptyByType();
    let firstSeen: Date | null = null;
    for (const r of rows) {
      const type = r.identifierType as IdentifierType;
      const bucket = byType[type];
      if (bucket) bucket.push(r.identifier);
      if (!firstSeen || r.firstSeen < firstSeen) firstSeen = r.firstSeen;
    }

    const identified =
      canonicalId.startsWith('usr_') || byType.user_id.length > 0 || byType.email_hash.length > 0;

    return { exists: rows.length > 0, canonicalId, identified, firstSeen, byType };
  }

  /** Reduz o grafo ao insumo do recompute (projeção). */
  private toResolvedGraph(graph: GraphByType): ResolvedGraph {
    return {
      canonicalId: graph.canonicalId,
      identified: graph.identified,
      actor: { userIds: graph.byType.user_id, anonymousIds: graph.byType.anonymous_id },
      emailHash: graph.byType.email_hash[0] ?? null,
      phoneHash: graph.byType.phone_hash[0] ?? null,
    };
  }

  // ─────────────────────────── views (snake_case) ───────────────────────────

  private toCandidate(canonicalId: string, graph: GraphByType, profile: UserProfile | null): ProfileCandidate {
    return {
      canonical_id: canonicalId,
      status: graph.identified ? 'identified' : 'anonymous',
      email_hash: graph.byType.email_hash[0] ?? null,
      phone_hash: graph.byType.phone_hash[0] ?? null,
      anonymous_ids_count: graph.byType.anonymous_id.length,
      metrics: profile?.metrics ?? null,
      first_seen_at: profile?.firstSeenAt?.toISOString() ?? graph.firstSeen?.toISOString() ?? null,
      last_seen_at: profile?.lastSeenAt?.toISOString() ?? null,
    };
  }

  private toProfileView(
    canonicalId: string,
    graph: GraphByType,
    profile: UserProfile | null,
    confidence: ProfileConfidence,
  ) {
    return {
      canonical_id: canonicalId,
      status: graph.identified ? 'identified' : 'anonymous',
      email_hash: graph.byType.email_hash[0] ?? null,
      phone_hash: graph.byType.phone_hash[0] ?? null,
      identity: {
        anonymous_ids: graph.byType.anonymous_id,
        devices: (profile?.devices ?? []) as ProfileDevice[],
        order_ids: graph.byType.order_id,
        click_ids: graph.byType.click_id,
      },
      // Sem identidade forte não há stitch cross-device: perfil parcial (estado honesto).
      cross_device_stitched: graph.identified,
      first_touch: profile?.firstTouch ?? null,
      last_touch: profile?.lastTouch ?? null,
      created_at: profile?.firstSeenAt?.toISOString() ?? graph.firstSeen?.toISOString() ?? null,
      last_seen_at: profile?.lastSeenAt?.toISOString() ?? null,
      metrics: profile?.metrics ?? null,
      confidence,
      projection: {
        recomputed_at: profile?.recomputedAt?.toISOString() ?? null,
        stale: this.projection.isStale(profile),
      },
    };
  }

  private timelineFilterMeta(dto: TimelineQueryDto): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (dto.start) meta.start = dto.start;
    if (dto.end) meta.end = dto.end;
    if (dto.event_name) meta.event_name = dto.event_name;
    if (dto.source) meta.source = dto.source;
    if (dto.device_type) meta.device_type = dto.device_type;
    if (dto.group_by) meta.group_by = dto.group_by;
    return meta;
  }

  private emptyTimeline(canonicalId: string, dto: TimelineQueryDto, clickhouseAvailable: boolean) {
    return {
      canonical_id: canonicalId,
      clickhouse_available: clickhouseAvailable,
      count: 0,
      next_cursor: null,
      ...(dto.group_by === 'day' ? { groups: [] } : { events: [] }),
    };
  }

  // ─────────────────────────── auditoria (regra 20) ───────────────────────────

  /**
   * Registra CADA acesso a um perfil individual em profile_access_log (trilha LGPD).
   * NUNCA grava PII em claro nem IP — apenas quem/quando/o quê + metadados de tipo.
   * Aguardado (auditoria durável): usa o mesmo Postgres já consultado nesta request.
   */
  private async logAccess(
    workspaceId: string,
    canonicalId: string,
    actor: AuthUser,
    action: ProfileAccessAction,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(profileAccessLog).values({
        id: `pal_${ulid()}`,
        workspaceId,
        canonicalId,
        accessedBy: actor.id,
        accessedByEmail: actor.email ?? null,
        action,
        metadata,
      });
    } catch (err) {
      // Auditoria é obrigatória, mas não deve derrubar a leitura por um blip do log.
      // TODO(live): fallback durável (outbox) + alerta se a trilha LGPD falhar.
      this.logger.error(`falha ao registrar profile_access_log: ${(err as Error).message}`);
    }
  }
}

/** Resumo de candidato da busca (desambiguação). */
export interface ProfileCandidate {
  canonical_id: string;
  status: 'anonymous' | 'identified';
  email_hash: string | null;
  phone_hash: string | null;
  anonymous_ids_count: number;
  metrics: UserProfile['metrics'] | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

// ─────────────────────────── funções puras (fora da classe) ───────────────────────────

function emptyByType(): Record<IdentifierType, string[]> {
  return {
    click_id: [],
    anonymous_id: [],
    user_id: [],
    email_hash: [],
    phone_hash: [],
    order_id: [],
  };
}

/** Momentos-chave marcados na timeline (PRD §7 M15). */
const KEY_MOMENTS = new Set(['identify', 'purchase', 'refund', 'subscription_started', 'subscription_cancelled']);

/** Um evento da timeline (contexto IP-free — regra 5; properties como objeto). */
interface TimelineEvent {
  event_id: string;
  event_name: string;
  source: string;
  timestamp: string | null;
  day: string | null;
  order_id: string | null;
  session_id: string | null;
  value: number;
  currency: string;
  marker: string | null;
  is_key_moment: boolean;
  properties: unknown;
  context: {
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    utm_content: string;
    utm_term: string;
    page_url: string;
    referrer: string;
    device_type: string;
    os: string;
    browser: string;
    ip_country: string; // regra 5: só país/cidade, NUNCA o IP bruto
    ip_city: string;
  };
}

function toTimelineEvent(r: TimelineRow): TimelineEvent {
  const iso = chTimestampToIso(r.event_ts);
  const isKey = KEY_MOMENTS.has(r.event_name);
  return {
    event_id: r.event_id,
    event_name: r.event_name,
    source: r.source,
    timestamp: iso,
    day: iso ? iso.slice(0, 10) : null,
    order_id: r.order_id || null,
    session_id: r.session_id || null,
    value: toNum(r.value),
    currency: r.currency,
    marker: isKey ? r.event_name : null,
    is_key_moment: isKey,
    properties: safeJson(r.properties),
    context: {
      utm_source: r.utm_source,
      utm_medium: r.utm_medium,
      utm_campaign: r.utm_campaign,
      utm_content: r.utm_content,
      utm_term: r.utm_term,
      page_url: r.page_url,
      referrer: r.referrer,
      device_type: r.device_type,
      os: r.os,
      browser: r.browser,
      ip_country: r.ip_country,
      ip_city: r.ip_city,
    },
  };
}

/** Agrupa a página (já ordenada DESC) em cabeçalhos de dia com contagem. */
function groupByDay(events: TimelineEvent[]): Array<{ day: string; count: number; events: TimelineEvent[] }> {
  const groups: Array<{ day: string; count: number; events: TimelineEvent[] }> = [];
  let current: { day: string; count: number; events: TimelineEvent[] } | null = null;
  for (const e of events) {
    const day = e.day ?? 'unknown';
    if (!current || current.day !== day) {
      current = { day, count: 0, events: [] };
      groups.push(current);
    }
    current.events.push(e);
    current.count++;
  }
  return groups;
}

/** Touchpoint renderizado na jornada, com o crédito do modelo. */
interface JourneyTouch {
  ts: string | null;
  channel: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  credit: number; // 0..1 (fração do crédito da conversão)
}

interface JourneyPath {
  order_id: string;
  converted_at: string | null;
  value: number;
  source: string;
  touches: JourneyTouch[];
}

/**
 * Monta os caminhos de conversão por pedido a partir dos touchpoints (ASC). Para
 * cada conversão (touchpoint com order_id), pega os touchpoints dentro da janela e
 * distribui 1.0 de crédito conforme o modelo. RENDERIZAÇÃO (ver TODO no service).
 */
export function buildJourneyPaths(
  touchpoints: TouchpointRow[],
  model: AttributionModel,
  windowDays: number,
): JourneyPath[] {
  const rows = touchpoints
    .map((t) => ({ ...t, at: chTimestampToIso(t.ts), atMs: msOf(t.ts) }))
    .filter((t) => t.atMs !== null)
    .sort((a, b) => (a.atMs as number) - (b.atMs as number));

  const windowMs = windowDays * 86_400_000;
  const conversions = rows.filter((t) => t.order_id && t.order_id.length > 0);
  const paths: JourneyPath[] = [];

  for (const conv of conversions) {
    const convMs = conv.atMs as number;
    // Touches na janela [conv - window, conv]. Inclui a própria linha de conversão.
    const inWindow = rows.filter((t) => {
      const ms = t.atMs as number;
      return ms <= convMs && ms >= convMs - windowMs;
    });
    const credits = assignCredit(inWindow.length, model);
    const touches: JourneyTouch[] = inWindow.map((t, i) => ({
      ts: t.at,
      channel: t.channel || deriveChannel(t.utm_source, t.utm_medium),
      utm_source: t.utm_source,
      utm_medium: t.utm_medium,
      utm_campaign: t.utm_campaign,
      credit: credits[i] ?? 0,
    }));
    paths.push({
      order_id: conv.order_id,
      converted_at: conv.at,
      value: toNum(conv.value),
      source: conv.source,
      touches,
    });
  }

  // Mais recentes primeiro (consistente com a timeline).
  return paths.sort((a, b) => (msOf2(b.converted_at) - msOf2(a.converted_at)));
}

/** Distribui 1.0 de crédito entre `n` touches conforme o modelo. */
function assignCredit(n: number, model: AttributionModel): number[] {
  if (n <= 0) return [];
  const credits = new Array<number>(n).fill(0);
  if (model === 'linear') {
    const share = 1 / n;
    for (let i = 0; i < n; i++) credits[i] = round4(share);
    return credits;
  }
  if (model === 'first_click') {
    credits[0] = 1;
    return credits;
  }
  // last_click (default): 100% no último toque da janela.
  credits[n - 1] = 1;
  return credits;
}

// ─────────────────────────── util ───────────────────────────

function toNum(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** ms de um DateTime64 do ClickHouse ('YYYY-MM-DD HH:MM:SS.mmm' UTC) ou null. */
function msOf(s: string | null | undefined): number | null {
  const iso = chTimestampToIso(s);
  return iso ? new Date(iso).getTime() : null;
}

function msOf2(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}
