import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
// NOTA DE INTEGRAÇÃO: `userProfiles`/`dataQualitySettings` só existem em @truvo/db após
// o barrel `schema/index.ts` re-exportar `./profiles` (M15) e `./data-quality` (M14) —
// ver schemaExports/openTODOs. Mesma convenção do M5/M6/M8.
import {
  userProfiles,
  dataQualitySettings,
  type UserProfile,
  type ProfileMetrics,
  type ProfileTouch,
  type ProfileDevice,
  type ProfileStatus,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { getClickHouse } from './profiles.infra';
import {
  buildDevicesSql,
  buildMetricsSql,
  buildReconGapSql,
  chTimestampToIso,
  deriveChannel,
  type ActorIdentifiers,
  type DeviceRow,
  type MetricsRow,
  type ReconGapRow,
} from './profiles-sql';

/**
 * Grafo de identidade resolvido (M8) de uma pessoa — o insumo do recompute.
 * `actor` (user_ids + anonymous_ids) é o filtro dos eventos no ClickHouse.
 */
export interface ResolvedGraph {
  canonicalId: string;
  identified: boolean;
  actor: ActorIdentifiers;
  emailHash: string | null;
  phoneHash: string | null;
}

/** Marca de incerteza do perfil (regra 12) — resolvida de reconciliation_daily (M14). */
export interface ProfileConfidence {
  reconciliation_gap: number | null;
  threshold: number;
  trusted: boolean;
  has_ground_truth: boolean;
  excludes_bot_events: true;
}

const DEFAULT_GAP_THRESHOLD = Number(process.env.RECONCILIATION_GAP_THRESHOLD ?? 0.02);
/** Janela de frescor da projeção antes de recomputar (staleness). */
const PROJECTION_TTL_MS = Number(process.env.PROFILE_PROJECTION_TTL_SECONDS ?? 300) * 1000;

const DAY_MS = 86_400_000;

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
};
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Projeção consolidada `user_profiles` (cache). Recomputa preguiçosamente (lazy) a
 * partir do ClickHouse em cache miss/stale e faz upsert — cobrindo o atraso do
 * recompute do worker de stitching do M8 (staleness, PRD §risco). Todas as métricas
 * excluem bots (is_bot = 0, regra 11). NUNCA persiste PII em claro nem IP (regras 4/5).
 */
@Injectable()
export class ProfileProjectionService {
  private readonly logger = new Logger(ProfileProjectionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Carrega a linha bruta da projeção (INCLUSIVE tombstones) ou null. O chamador
   * decide o tratamento — a checagem de tombstone (regra 20) fica explícita para
   * NUNCA reanimar um perfil expurgado num recompute.
   */
  async loadRaw(workspaceId: string, canonicalId: string): Promise<UserProfile | null> {
    const [row] = await this.db
      .select()
      .from(userProfiles)
      .where(and(eq(userProfiles.workspaceId, workspaceId), eq(userProfiles.canonicalId, canonicalId)))
      .limit(1);
    return row ?? null;
  }

  /** true quando a projeção está ausente/velha e vale recomputar. */
  isStale(row: UserProfile | null): boolean {
    if (!row) return true;
    if (!row.recomputedAt) return true;
    return Date.now() - row.recomputedAt.getTime() > PROJECTION_TTL_MS;
  }

  /**
   * Garante uma projeção fresca: carrega o cache; se ausente/stale, recomputa do
   * ClickHouse e faz upsert. Best-effort — se o ClickHouse cair, devolve o cache
   * existente (ou null). Nunca lança por indisponibilidade de infra analítica.
   *
   * Regra 20 (LGPD): um perfil TOMBSTONE é devolvido como está, SEM recompute — o
   * chamador o trata como "não encontrado" e o perfil nunca "ressuscita" dados já
   * marcados para exclusão, mesmo com a mutation no ClickHouse ainda assíncrona.
   */
  async getFresh(workspaceId: string, graph: ResolvedGraph): Promise<UserProfile | null> {
    const cached = await this.loadRaw(workspaceId, graph.canonicalId);
    if (cached?.tombstonedAt) return cached; // não recomputa/reanima.
    if (!this.isStale(cached)) return cached;

    try {
      return await this.recompute(workspaceId, graph);
    } catch (err) {
      this.logger.warn(
        `recompute falhou (ClickHouse indisponível?) canonical=${graph.canonicalId}: ${(err as Error).message}`,
      );
      return cached; // degrada para o cache (mesmo stale) em vez de falhar a request.
    }
  }

  /**
   * Recomputa métricas/touches/devices do ClickHouse e faz upsert na projeção.
   * Sem eventos → grava um perfil "vazio" consistente (o grafo pode existir sem
   * eventos ainda ingeridos). Lança se o ClickHouse estiver indisponível.
   */
  async recompute(workspaceId: string, graph: ResolvedGraph): Promise<UserProfile> {
    const { actor } = graph;
    const noActors = actor.userIds.length === 0 && actor.anonymousIds.length === 0;

    let metricsRow: MetricsRow | undefined;
    let deviceRows: DeviceRow[] = [];

    if (!noActors) {
      const ch = getClickHouse();
      const m = buildMetricsSql(workspaceId, actor);
      const mrs = await ch.query({ query: m.sql, query_params: m.params, format: 'JSONEachRow' });
      metricsRow = (await mrs.json<MetricsRow>())[0];

      const d = buildDevicesSql(workspaceId, actor);
      const drs = await ch.query({ query: d.sql, query_params: d.params, format: 'JSONEachRow' });
      deviceRows = await drs.json<DeviceRow>();
    }

    const eventsCount = num(metricsRow?.events_count);
    const firstIso = eventsCount > 0 ? chTimestampToIso(metricsRow?.first_ts ?? null) : null;
    const lastIso = eventsCount > 0 ? chTimestampToIso(metricsRow?.last_ts ?? null) : null;

    const ltv = round2(num(metricsRow?.ltv));
    const ordersCount = num(metricsRow?.orders_count);
    const metrics: ProfileMetrics = {
      ltv,
      orders_count: ordersCount,
      aov: ordersCount > 0 ? round2(ltv / ordersCount) : 0,
      sessions_count: num(metricsRow?.sessions_count),
      events_count: eventsCount,
      days_since_first_touch: daysBetween(firstIso, lastIso),
      currency: metricsRow?.currency ?? '',
    };

    const firstTouch: ProfileTouch | null = firstIso
      ? {
          channel: deriveChannel(metricsRow?.ft_utm_source, metricsRow?.ft_utm_medium),
          utm_source: emptyToUndef(metricsRow?.ft_utm_source),
          utm_medium: emptyToUndef(metricsRow?.ft_utm_medium),
          utm_campaign: emptyToUndef(metricsRow?.ft_utm_campaign),
          at: firstIso,
        }
      : null;
    const lastTouch: ProfileTouch | null = lastIso
      ? {
          channel: deriveChannel(metricsRow?.lt_utm_source, metricsRow?.lt_utm_medium),
          utm_source: emptyToUndef(metricsRow?.lt_utm_source),
          utm_medium: emptyToUndef(metricsRow?.lt_utm_medium),
          utm_campaign: emptyToUndef(metricsRow?.lt_utm_campaign),
          at: lastIso,
        }
      : null;

    const devices: ProfileDevice[] = deviceRows.map((r) => ({
      device_type: r.device_type,
      os: r.os,
      browser: r.browser,
      first_seen: chTimestampToIso(r.first_seen) ?? firstIso ?? new Date(0).toISOString(),
    }));

    const status: ProfileStatus = graph.identified ? 'identified' : 'anonymous';
    const now = new Date();

    const values = {
      workspaceId,
      canonicalId: graph.canonicalId,
      status,
      emailHash: graph.emailHash,
      phoneHash: graph.phoneHash,
      firstTouch,
      lastTouch,
      metrics,
      mergedAnonymousIds: actor.anonymousIds,
      devices,
      firstSeenAt: firstIso ? new Date(firstIso) : null,
      lastSeenAt: lastIso ? new Date(lastIso) : null,
      recomputedAt: now,
      updatedAt: now,
    };

    const [row] = await this.db
      .insert(userProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: [userProfiles.workspaceId, userProfiles.canonicalId],
        // regra 20: NÃO reanima tombstones — não tocamos em tombstoned_at no upsert.
        set: {
          status: values.status,
          emailHash: values.emailHash,
          phoneHash: values.phoneHash,
          firstTouch: values.firstTouch,
          lastTouch: values.lastTouch,
          metrics: values.metrics,
          mergedAnonymousIds: values.mergedAnonymousIds,
          devices: values.devices,
          firstSeenAt: values.firstSeenAt,
          lastSeenAt: values.lastSeenAt,
          recomputedAt: values.recomputedAt,
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    return row ?? ({ ...values, tombstonedAt: null, createdAt: now } as UserProfile);
  }

  /**
   * Marca de incerteza (regra 12): pior gap de reconciliação (M14) no período de
   * atividade da pessoa vs. limiar do workspace (data_quality_settings) → env default.
   * Best-effort: se o ClickHouse cair, retorna `trusted:true` sem ground truth.
   */
  async confidence(
    workspaceId: string,
    firstSeenAt: Date | null,
    lastSeenAt: Date | null,
  ): Promise<ProfileConfidence> {
    const threshold = await this.gapThreshold(workspaceId);
    const base: ProfileConfidence = {
      reconciliation_gap: null,
      threshold,
      trusted: true,
      has_ground_truth: false,
      excludes_bot_events: true,
    };
    if (!firstSeenAt || !lastSeenAt) return base;

    try {
      const ch = getClickHouse();
      const { sql, params } = buildReconGapSql(workspaceId, firstSeenAt, lastSeenAt);
      const rs = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
      const row = (await rs.json<ReconGapRow>())[0];
      const hasGroundTruth = num(row?.has_ground_truth) > 0;
      // Sem ground truth (nenhum dia com receita de gateway) → gap indefinido (não 0):
      // não há como afirmar (in)certeza; o front mostra "não confirmado pelo gateway".
      const gap = !hasGroundTruth || row?.gap == null ? null : num(row.gap);
      return {
        reconciliation_gap: gap,
        threshold,
        trusted: gap == null ? true : gap <= threshold,
        has_ground_truth: hasGroundTruth,
        excludes_bot_events: true,
      };
    } catch (err) {
      this.logger.debug(`confidence: reconciliation_daily indisponível: ${(err as Error).message}`);
      return base;
    }
  }

  /** Limiar de gap por workspace (data_quality_settings, M14) → fallback env global. */
  private async gapThreshold(workspaceId: string): Promise<number> {
    try {
      const [cfg] = await this.db
        .select({ threshold: dataQualitySettings.reconciliationGapThreshold })
        .from(dataQualitySettings)
        .where(eq(dataQualitySettings.workspaceId, workspaceId))
        .limit(1);
      return cfg?.threshold ?? DEFAULT_GAP_THRESHOLD;
    } catch {
      return DEFAULT_GAP_THRESHOLD;
    }
  }
}

function emptyToUndef(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

function daysBetween(firstIso: string | null, lastIso: string | null): number {
  if (!firstIso || !lastIso) return 0;
  const diff = new Date(lastIso).getTime() - new Date(firstIso).getTime();
  return diff > 0 ? Math.floor(diff / DAY_MS) : 0;
}
