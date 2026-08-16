import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { ulid } from 'ulid';
// NOTA DE INTEGRAÇÃO: `identityLinks`/`identityMerges` só existem em @truvo/db após
// o barrel `schema/index.ts` re-exportar `./identity` na integração do M8 (openTODOs).
import {
  identityLinks,
  identityMerges,
  type IdentityMerge,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { sha256 } from '../events/crypto.util';
import { getClickHouse, getRedis } from './identity.infra';
import { IDENTITY_STITCH_STREAM, type StitchJob } from './identity.constants';
import type { IdentifierType, IdentifyDto, MergesQueryDto } from './dto/identity.dto';
import { CustomerContextService } from '../customer-context/customer-context.service';

/** Uma aresta identificador→tipo, montada a partir do payload de identify. */
interface IdRef {
  identifier: string;
  type: IdentifierType;
}

/** Grafo resolvido de uma pessoa (canonical_id) — agrupado por tipo. */
export interface IdentityGraphView {
  found: boolean;
  canonical_id: string | null;
  identified: boolean;
  first_seen: string | null;
  identity: Record<IdentifierType, string[]>;
}

/** Grafo vazio com arrays FRESCOS (nunca compartilhar referências entre respostas). */
function emptyGraph(): Record<IdentifierType, string[]> {
  return {
    click_id: [],
    anonymous_id: [],
    user_id: [],
    email_hash: [],
    phone_hash: [],
    order_id: [],
  };
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customerContext: CustomerContextService,
  ) {}

  // ───────────────────────────── lookup ─────────────────────────────

  /**
   * GET /v1/identity/lookup — resolve um identificador → canonical_id e devolve o
   * grafo fundido (todos os identificadores da pessoa). `identifier` é ÚNICO por
   * workspace, então a resolução é por (workspace_id, identifier); `type` é
   * validado mas não restringe (o valor é autoritativo). Regra 1: filtra workspace.
   */
  async lookup(workspaceId: string, identifier: string, _type: IdentifierType): Promise<IdentityGraphView> {
    const anchor = await this.db
      .select({ canonicalId: identityLinks.canonicalId })
      .from(identityLinks)
      .where(and(eq(identityLinks.workspaceId, workspaceId), eq(identityLinks.identifier, identifier)))
      .limit(1);

    const canonicalId = anchor[0]?.canonicalId;
    if (!canonicalId) {
      return { found: false, canonical_id: null, identified: false, first_seen: null, identity: emptyGraph() };
    }

    return this.graphOf(workspaceId, canonicalId);
  }

  /** Monta o grafo (agrupado por tipo) de um canonical dentro do workspace. */
  private async graphOf(workspaceId: string, canonicalId: string): Promise<IdentityGraphView> {
    const rows = await this.db
      .select({
        identifier: identityLinks.identifier,
        identifierType: identityLinks.identifierType,
        firstSeen: identityLinks.firstSeen,
      })
      .from(identityLinks)
      .where(and(eq(identityLinks.workspaceId, workspaceId), eq(identityLinks.canonicalId, canonicalId)))
      .orderBy(identityLinks.firstSeen);

    const identity = emptyGraph();
    let firstSeen: Date | undefined;
    for (const r of rows) {
      const type = r.identifierType as IdentifierType;
      const bucket = identity[type];
      if (bucket) bucket.push(r.identifier);
      if (!firstSeen || r.firstSeen < firstSeen) firstSeen = r.firstSeen;
    }

    const identified = canonicalId.startsWith('usr_') || identity.user_id.length > 0 || identity.email_hash.length > 0;

    return {
      found: true,
      canonical_id: canonicalId,
      identified,
      first_seen: firstSeen ? firstSeen.toISOString() : null,
      identity,
    };
  }

  // ──────────────────────────── identify ────────────────────────────

  /**
   * POST /v1/identity/identify — o coração do stitching (PRD §7 M8 "User Stitching").
   *
   * 1. hasheia email/phone em claro (regra 4) e monta as arestas do payload;
   * 2. numa transação, resolve o `canonical_id` estável (usr_ > anon_), funde os
   *    canonicals pré-existentes divergentes (registrando identity_merges) e
   *    faz upsert de cada aresta;
   * 3. enfileira o stitching RETROATIVO se houve merge (fila/worker do consumer);
   * 4. registra um touchpoint (M7) quando há canal/UTM/conversão no contexto.
   *
   * Idempotente: reexecutar o mesmo payload converge para o mesmo canonical sem
   * gerar merges novos (as arestas já apontam para o vencedor).
   */
  async identify(workspaceId: string, dto: IdentifyDto) {
    const emailHash = dto.email_hash?.toLowerCase() ?? (dto.email ? sha256(dto.email.trim().toLowerCase()) : undefined);
    const phoneHash =
      dto.phone_hash?.toLowerCase() ?? (dto.phone ? sha256(dto.phone.replace(/[^\d]/g, '')) : undefined);

    const refs: IdRef[] = [];
    if (dto.anonymous_id) refs.push({ identifier: dto.anonymous_id, type: 'anonymous_id' });
    if (dto.user_id) refs.push({ identifier: dto.user_id, type: 'user_id' });
    if (emailHash) refs.push({ identifier: emailHash, type: 'email_hash' });
    if (phoneHash) refs.push({ identifier: phoneHash, type: 'phone_hash' });
    if (dto.click_id) refs.push({ identifier: dto.click_id, type: 'click_id' });
    if (dto.order_id) refs.push({ identifier: dto.order_id, type: 'order_id' });

    if (refs.length === 0) {
      // A validação zod já garante isto; defesa em profundidade.
      throw new BadRequestException('nenhum identificador informado');
    }

    const now = new Date();
    const identifierValues = refs.map((r) => r.identifier);

    const { target, losers } = await this.db.transaction(async (tx) => {
      // 1. canonicals já existentes para qualquer aresta informada.
      const existing = await tx
        .select({ canonicalId: identityLinks.canonicalId, firstSeen: identityLinks.firstSeen })
        .from(identityLinks)
        .where(
          and(eq(identityLinks.workspaceId, workspaceId), inArray(identityLinks.identifier, identifierValues)),
        );

      const firstSeenByCanonical = new Map<string, Date>();
      for (const row of existing) {
        const prev = firstSeenByCanonical.get(row.canonicalId);
        if (!prev || row.firstSeen < prev) firstSeenByCanonical.set(row.canonicalId, row.firstSeen);
      }
      const existingCanonicals = [...firstSeenByCanonical.keys()];

      // 2. canonical alvo (estável): user_id > canonical identificado > mais antigo > raiz anon.
      const target = chooseCanonical(dto.user_id, existingCanonicals, firstSeenByCanonical, dto.anonymous_id);

      // 3. merges: todo canonical pré-existente != alvo é fundido no alvo.
      const losers = existingCanonicals.filter((c) => c !== target);
      const reason = dto.user_id ? 'identify:user_id' : emailHash ? 'stitch:email_hash' : 'stitch:identifier';
      for (const loser of losers) {
        await tx
          .update(identityLinks)
          .set({ canonicalId: target })
          .where(and(eq(identityLinks.workspaceId, workspaceId), eq(identityLinks.canonicalId, loser)));
        await tx.insert(identityMerges).values({
          id: `mrg_${ulid()}`,
          workspaceId,
          canonicalId: target,
          mergedFrom: loser,
          reason,
          at: now,
        });
      }

      // 4. upsert de cada aresta → alvo (mantém first_seen; só re-aponta canonical).
      for (const ref of refs) {
        await tx
          .insert(identityLinks)
          .values({
            id: `idl_${ulid()}`,
            workspaceId,
            identifier: ref.identifier,
            identifierType: ref.type,
            canonicalId: target,
            firstSeen: now,
          })
          .onConflictDoUpdate({
            target: [identityLinks.workspaceId, identityLinks.identifier],
            set: { canonicalId: target },
          });
      }

      return { target, losers };
    });

    const identified = target.startsWith('usr_') || Boolean(emailHash) || Boolean(dto.user_id);
    const reason = dto.user_id ? 'identify:user_id' : emailHash ? 'stitch:email_hash' : 'stitch:identifier';

    // Additive bridge: M8 remains authoritative for merge decisions. Canonical
    // Context only mirrors its deterministic result and provider-namespaced IDs.
    await this.customerContext.synchronizeLegacyIdentity(workspaceId, target, refs, losers, now);

    // 3. stitching retroativo: só quando algo foi fundido (recompute é caro — PRD §15).
    if (losers.length > 0) {
      await this.enqueueRetroStitch({
        workspace_id: workspaceId,
        canonical_id: target,
        merged_from: losers,
        reason,
        enqueued_at: now.toISOString(),
      });
    }

    // 4. touchpoint p/ o M7 (best-effort) quando há sinal de canal/UTM/conversão.
    await this.maybeRecordTouchpoint(workspaceId, target, dto, now);

    return {
      canonical_id: target,
      identified,
      merged_from: losers,
      merged: losers.length > 0,
    };
  }

  // ───────────────────────────── merges ─────────────────────────────

  /** GET /v1/identity/merges — histórico de fusões (desc por tempo, cursor por `at`). */
  async listMerges(workspaceId: string, q: MergesQueryDto) {
    const conditions = [eq(identityMerges.workspaceId, workspaceId)];
    if (q.canonical_id) conditions.push(eq(identityMerges.canonicalId, q.canonical_id));
    if (q.cursor) conditions.push(lt(identityMerges.at, new Date(q.cursor)));

    const rows = await this.db
      .select()
      .from(identityMerges)
      .where(and(...conditions))
      .orderBy(desc(identityMerges.at))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];

    return {
      merges: page.map((r) => this.toMergeView(r)),
      next_cursor: hasMore && last ? last.at.toISOString() : null,
    };
  }

  private toMergeView(r: IdentityMerge) {
    return {
      id: r.id,
      canonical_id: r.canonicalId,
      merged_from: r.mergedFrom,
      reason: r.reason,
      at: r.at.toISOString(),
    };
  }

  // ─────────────────────────── touchpoints ──────────────────────────

  /**
   * Grava um touchpoint (ClickHouse) quando o identify carrega canal/UTM/conversão.
   * Best-effort: se o ClickHouse não estiver no ar (dev), apenas loga.
   *
   * // TODO(live): o caminho principal de touchpoints é o stream de eventos (o
   * consumer resolve canonical_id por evento e insere). Este atalho cobre o
   * identify server-side direto. Dedup de order_id por SOURCE_PRIORITY já foi
   * feita no consumer do M2 (regra 2/10) — aqui `source` é só proveniência.
   */
  private async maybeRecordTouchpoint(workspaceId: string, canonicalId: string, dto: IdentifyDto, ts: Date) {
    const ctx = dto.context ?? {};
    const hasSignal = Boolean(
      ctx.channel || ctx.utm_source || ctx.utm_medium || ctx.utm_campaign || dto.click_id || dto.order_id,
    );
    if (!hasSignal) return;

    const channel = ctx.channel ?? deriveChannel(ctx.utm_source, ctx.utm_medium);
    try {
      const ch = getClickHouse();
      await ch.insert({
        table: 'touchpoints',
        values: [
          {
            workspace_id: workspaceId,
            canonical_id: canonicalId,
            ts: toChDateTime(ts),
            channel,
            utm_source: ctx.utm_source ?? '',
            utm_medium: ctx.utm_medium ?? '',
            utm_campaign: ctx.utm_campaign ?? '',
            click_id: dto.click_id ?? '',
            order_id: dto.order_id ?? '',
            source: dto.source ?? 'api',
            event_id: `idt_${ulid()}`,
            value: 0,
            is_bot: 0,
          },
        ],
        format: 'JSONEachRow',
      });
    } catch (err) {
      this.logger.debug(`touchpoint insert falhou (ClickHouse indisponível?): ${(err as Error).message}`);
    }
  }

  // ─────────────────────────── retro fila ───────────────────────────

  /**
   * Enfileira o job de stitching retroativo num Redis STREAM (consumer group +
   * checkpoints no worker). Best-effort no producer: se o Redis piscar, logamos —
   * o merge no Postgres já está persistido e um replay/backfill pode reprocessar.
   */
  private async enqueueRetroStitch(job: StitchJob) {
    try {
      const redis = getRedis();
      await redis.xadd(
        IDENTITY_STITCH_STREAM,
        '*',
        'workspace_id',
        job.workspace_id,
        'canonical_id',
        job.canonical_id,
        'merged_from',
        JSON.stringify(job.merged_from),
        'reason',
        job.reason,
        'enqueued_at',
        job.enqueued_at,
      );
    } catch (err) {
      // TODO(live): fallback durável (outbox no Postgres) se o Redis estiver fora.
      this.logger.warn(`falha ao enfileirar stitch retroativo: ${(err as Error).message}`);
    }
  }
}

/**
 * Escolhe o canonical estável:
 *   1. `user_id` explícito → `usr_<user_id>` (identificação forte);
 *   2. senão, entre os canonicals pré-existentes prefere um IDENTIFICADO (`usr_`);
 *   3. desempate por menor `first_seen` (mais antigo vence), depois lexicográfico;
 *   4. sem nenhum pré-existente → raiz `anon_<anonymous_id>` ou um novo `anon_<ulid>`.
 */
function chooseCanonical(
  userId: string | undefined,
  existingCanonicals: string[],
  firstSeen: Map<string, Date>,
  anonymousId: string | undefined,
): string {
  if (userId) return `usr_${userId}`;

  const identified = existingCanonicals.filter((c) => c.startsWith('usr_'));
  const pool = identified.length > 0 ? identified : existingCanonicals;
  if (pool.length > 0) return pickEarliest(pool, firstSeen);

  if (anonymousId) return `anon_${anonymousId}`;
  return `anon_${ulid()}`;
}

/** Menor first_seen vence; empate → menor string (determinístico). `pool` não-vazio. */
function pickEarliest(pool: string[], firstSeen: Map<string, Date>): string {
  let best: string | undefined;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const c of pool) {
    const t = firstSeen.get(c)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (best === undefined || t < bestTime || (t === bestTime && c < best)) {
      best = c;
      bestTime = t;
    }
  }
  return best as string;
}

/** Deriva um canal grosseiro a partir de utm_medium/utm_source (fallback: direct). */
function deriveChannel(utmSource: string | undefined, utmMedium: string | undefined): string {
  const medium = (utmMedium ?? '').toLowerCase();
  if (medium === 'cpc' || medium === 'ppc' || medium === 'paid' || medium === 'paidsearch') return 'paid_search';
  if (medium === 'social' || medium === 'paid_social' || medium === 'paidsocial') return 'paid_social';
  if (medium === 'email') return 'email';
  if (medium === 'organic') return 'organic';
  if (medium === 'referral') return 'referral';
  if (utmSource) return 'referral';
  return 'direct';
}

/** DateTime64(3) do ClickHouse: 'YYYY-MM-DD HH:MM:SS.mmm' (UTC, sem 'Z'). */
function toChDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
