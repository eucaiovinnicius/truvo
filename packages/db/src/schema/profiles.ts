import { pgEnum, pgTable, text, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * M15 — CUSTOMER PROFILE / USER 360 (schema Postgres, PRD §7 Módulo 15).
 *
 * Duas tabelas. A leitura pesada (timeline, jornada) é toda no ClickHouse (`events`,
 * `touchpoints`) — sempre com workspace_id + is_bot = 0 (regras 1 e 11). No Postgres
 * ficam:
 *
 *   · user_profiles     → PROJEÇÃO CONSOLIDADA (cache) do cabeçalho + métricas de UMA
 *                         pessoa (canonical_id). 1 linha por (workspace_id, canonical_id).
 *                         É recomputada pelo worker de stitching do M8 após
 *                         identify/purchase e após stitch retroativo; o M15 também a
 *                         recomputa preguiçosamente (lazy) em cache miss/stale a partir
 *                         do ClickHouse. Serve busca e cabeçalho rápidos — a timeline
 *                         SEMPRE vem fresca do ClickHouse (PRD §7 M15).
 *   · profile_access_log→ AUDITORIA LGPD: quem acessou qual perfil individual, quando e
 *                         o quê (busca/visualização/timeline/identidades/jornada). Toda
 *                         leitura de PII de uma pessoa registra uma linha (regra 20).
 *
 * Regras respeitadas:
 *   1  — toda leitura/escrita filtra por workspace_id; identidades NUNCA cruzam
 *        workspaces (o MESMO email_hash em dois tenants são DUAS pessoas — regra 20).
 *   4/5— e-mail/telefone só como hash (SHA-256); IP nunca persistido/exibido (só
 *        country/city vêm das colunas achatadas de `events`). Nada de PII em claro aqui.
 *   11 — as métricas da projeção são calculadas EXCLUINDO is_bot = 1.
 *   12 — a incerteza (reconciliation_gap > limiar, M14) é resolvida em tempo de leitura;
 *        não é persistida na projeção (a fonte é `reconciliation_daily`).
 *   20 — LGPD/esquecimento: `tombstoned_at` marca o perfil como expurgado; a busca e o
 *        perfil o escondem IMEDIATAMENTE, mesmo com a mutation no ClickHouse ainda
 *        assíncrona — o perfil nunca "ressuscita" dados já marcados para exclusão.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './profiles'`) na onda de
 * integração para que `@truvo/db` exponha `userProfiles`, `profileAccessLog` e os
 * enums. O barrel NÃO é editado por este módulo (contrato de arquivos) — reportado
 * em `schemaExports`/`openTODOs`.
 *
 * Obs.: `workspace_id`/`canonical_id`/`accessed_by` são `text` (não FK) — mesmo padrão
 * do M2/M6/M8 — para permanecerem compatíveis com o formato de id do M1 (Auth) e com
 * `workspace_id: z.string()` do @truvo/event-schema.
 */

// ─────────────────────────── enums ───────────────────────────

/** Status de identidade consolidada da pessoa (PRD §7 M15 "Cabeçalho"). */
export const PROFILE_STATUSES = ['anonymous', 'identified'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export const profileStatusEnum = pgEnum('profile_status', PROFILE_STATUSES);

/** Ação auditada no acesso a um perfil individual (trilha LGPD — regra 20). */
export const PROFILE_ACCESS_ACTIONS = [
  'search',
  'view_profile',
  'view_timeline',
  'view_identities',
  'view_journey',
  'export',
] as const;
export type ProfileAccessAction = (typeof PROFILE_ACCESS_ACTIONS)[number];
export const profileAccessActionEnum = pgEnum('profile_access_action', PROFILE_ACCESS_ACTIONS);

// ─────────────────────── tipos JSONB (fonte de verdade) ───────────────────────

/** Um "toque" de marketing (primeiro/último) — canal + UTM + instante. Liga o M7. */
export interface ProfileTouch {
  channel: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** ISO 8601. */
  at: string;
}

/**
 * Métricas consolidadas da pessoa (todas EXCLUINDO bots — regra 11).
 * `ltv` é a receita reconciliada; a marca de incerteza (regra 12) é calculada em
 * tempo de leitura a partir de `reconciliation_daily` (M14) e não fica aqui.
 */
export interface ProfileMetrics {
  /** LTV (soma de `value`/receita das conversões, is_bot = 0). */
  ltv: number;
  /** count distinct order_id. */
  orders_count: number;
  /** ltv / orders_count (0 quando sem pedidos). */
  aov: number;
  /** distintos de session_id. */
  sessions_count: number;
  /** total de eventos (is_bot = 0). */
  events_count: number;
  /** dias desde o primeiro toque até o último visto. */
  days_since_first_touch: number;
  /** moeda predominante (ISO 4217) — '' quando desconhecida. */
  currency: string;
}

/** Um device costurado na mesma pessoa (device_type + os + browser). */
export interface ProfileDevice {
  device_type: string;
  os: string;
  browser: string;
  /** ISO 8601 — primeiro instante em que o device foi visto. */
  first_seen: string;
}

// ─────────────────────────── tabelas ───────────────────────────

export const userProfiles = pgTable(
  'user_profiles',
  {
    /** Tenant dono da projeção (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /**
     * Chave estável da pessoa dentro do workspace: `usr_<user_id>` quando
     * identificada, senão a raiz `anon_<anonymous_id>` (espelha M8 identity_links).
     */
    canonicalId: text('canonical_id').notNull(),

    status: profileStatusEnum('status').notNull().default('anonymous'),

    /** SHA-256 do e-mail (regra 4) — nunca o valor em claro. NULL quando anônimo. */
    emailHash: text('email_hash'),
    /** SHA-256 do telefone E.164 (regra 4). NULL quando ausente. */
    phoneHash: text('phone_hash'),

    /** Primeiro/último toque (canal + UTM + instante) — liga o M7. */
    firstTouch: jsonb('first_touch').$type<ProfileTouch | null>(),
    lastTouch: jsonb('last_touch').$type<ProfileTouch | null>(),

    /** Métricas consolidadas (LTV/orders/aov/sessions/events…), is_bot = 0. */
    metrics: jsonb('metrics').$type<ProfileMetrics>(),

    /** Todos os `anonymous_id` costurados na pessoa (stitch cross-device). */
    mergedAnonymousIds: jsonb('merged_anonymous_ids').$type<string[]>().notNull().default([]),
    /** Devices fundidos (device_type + os + browser + first_seen). */
    devices: jsonb('devices').$type<ProfileDevice[]>().notNull().default([]),

    /** created_at do perfil = primeiro evento visto (menor timestamp). */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    /** Último evento visto (maior timestamp). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    /**
     * Instante do último recompute da projeção. Base da detecção de STALENESS: o M15
     * recomputa a partir do ClickHouse quando esta marca é antiga (ou NULL) —
     * cobre o atraso do recompute após stitch retroativo (PRD §7 M15 / §risco).
     */
    recomputedAt: timestamp('recomputed_at', { withTimezone: true }),

    /**
     * LGPD / direito ao esquecimento (regra 20): quando preenchido, o titular foi
     * expurgado (seção 11). O perfil vira TOMBSTONE e some da busca/leitura
     * IMEDIATAMENTE, mesmo com a mutation no ClickHouse ainda assíncrona.
     */
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 1 linha por pessoa dentro do workspace (regra 1 + idempotência do upsert).
    pk: primaryKey({ columns: [t.workspaceId, t.canonicalId] }),
    // Busca por e-mail/telefone (hash) → canonical, sempre escopada por workspace.
    emailIdx: index('user_profiles_ws_email_idx').on(t.workspaceId, t.emailHash),
    phoneIdx: index('user_profiles_ws_phone_idx').on(t.workspaceId, t.phoneHash),
    // Listagens/varreduras recentes por atividade.
    lastSeenIdx: index('user_profiles_ws_last_seen_idx').on(t.workspaceId, t.lastSeenAt),
  }),
);

export const profileAccessLog = pgTable(
  'profile_access_log',
  {
    id: text('id').primaryKey(), // pal_<ulid>
    /** Tenant do perfil acessado (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /** Perfil (pessoa) acessado. Para 'search' pode ser o canonical resolvido ou ''. */
    canonicalId: text('canonical_id').notNull().default(''),
    /** Quem acessou (id do usuário autenticado — M1). */
    accessedBy: text('accessed_by').notNull(),
    /** E-mail do operador, quando disponível (auditoria legível). */
    accessedByEmail: text('accessed_by_email'),
    /** O quê: search | view_profile | view_timeline | view_identities | view_journey | export. */
    action: profileAccessActionEnum('action').notNull(),
    /**
     * Metadados NÃO sensíveis do acesso (ex.: { search_type, filters, result_count }).
     * NUNCA guarda PII em claro nem IP (regras 4/5) — no máximo o TIPO da busca.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Trilha por perfil (regra 20): "quem viu esta pessoa e quando".
    profileIdx: index('profile_access_log_ws_canonical_at_idx').on(
      t.workspaceId,
      t.canonicalId,
      t.at,
    ),
    // Trilha por operador: "o que este usuário acessou".
    actorIdx: index('profile_access_log_ws_actor_at_idx').on(t.workspaceId, t.accessedBy, t.at),
  }),
);

export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type ProfileAccessLogRow = typeof profileAccessLog.$inferSelect;
export type NewProfileAccessLogRow = typeof profileAccessLog.$inferInsert;
