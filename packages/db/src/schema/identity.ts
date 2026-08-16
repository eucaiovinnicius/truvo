import { pgEnum, pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Order 055 — `deleted_at` added (nullable, additive) so v1's identity graph can
 * participate in the SAME tombstone-then-purge lifecycle every other subject-owned
 * table already uses, instead of a one-off erasure mechanism just for this table.
 * `IdentityService`'s read paths (`lookup`/`graphOf`/`identify`'s existing-canonicals
 * lookup) now filter `isNull(deletedAt)` — see identity.service.ts.
 */

/**
 * M8 — IDENTITY RESOLUTION + DEDUP avançado (PRD §7 Módulo 8, §8).
 *
 * O identity graph liga TODOS os identificadores de uma mesma pessoa
 * (`click_id`, `anonymous_id`, `user_id`, `email_hash`, `phone_hash`, `order_id`)
 * a um `canonical_id` estável — `usr_<user_id>` quando identificada, senão a raiz
 * `anon_<anonymous_id>`. Duas tabelas Postgres:
 *
 *   - identity_links  → aresta identificador → canonical_id (1 linha por
 *                       identificador dentro do workspace). `first_seen` preserva
 *                       o primeiro avistamento; o merge só re-aponta `canonical_id`.
 *   - identity_merges → histórico append-only de fusões (canonical vencedor ←
 *                       canonical perdedor), com motivo e instante — auditável e
 *                       base do stitching retroativo (fila/worker).
 *
 * Regras de negócio respeitadas:
 *   1  — TODA leitura/escrita filtra por `workspace_id`. Identidades NUNCA cruzam
 *        workspaces: o MESMO `email_hash` em dois tenants são DUAS pessoas.
 *   4  — e-mail/telefone só entram como SHA-256 (`email_hash`/`phone_hash`),
 *        nunca em claro (o hash é feito na borda antes de persistir).
 *   2/10 — dedup por `order_id` continua sendo do consumer do M2 (SOURCE_PRIORITY);
 *        aqui o `order_id` é apenas mais um identificador do grafo (unicidade por
 *        workspace garante idempotência do vínculo → canonical).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (barrel) na onda de integração para que
 * `@truvo/db` exponha `identityLinks`, `identityMerges` e o enum. O barrel NÃO é
 * editado por este módulo (contrato de arquivos) — ver openTODOs.
 *
 * Obs.: `workspace_id`/`canonical_id`/`identifier` são `text` (não FK) para
 * permanecerem compatíveis com o formato de id do M1 (Auth) e com
 * `workspace_id: z.string()` do @truvo/event-schema.
 */

/** Tipos de identificador aceitos no grafo (PRD §7 M8). */
export const IDENTIFIER_TYPES = [
  'click_id',
  'anonymous_id',
  'user_id',
  'email_hash',
  'phone_hash',
  'order_id',
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export const identifierTypeEnum = pgEnum('identity_identifier_type', IDENTIFIER_TYPES);

export const identityLinks = pgTable(
  'identity_links',
  {
    id: text('id').primaryKey(), // idl_<ulid> (gerado no serviço)
    /** Tenant dono da aresta (regra 1 — isolamento multi-tenant). */
    workspaceId: text('workspace_id').notNull(),
    /**
     * Valor do identificador. Para e-mail/telefone é o SHA-256 (regra 4), nunca
     * o valor em claro. Único por workspace (um identificador → um canonical).
     */
    identifier: text('identifier').notNull(),
    identifierType: identifierTypeEnum('identifier_type').notNull(),
    /**
     * Chave estável da pessoa dentro do workspace: `usr_<user_id>` quando
     * identificada, senão a raiz `anon_<anonymous_id>`. O merge re-aponta esta
     * coluna; `first_seen` permanece.
     */
    canonicalId: text('canonical_id').notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    /** Order 055: tombstone for subject erasure — nullable, additive. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    // regra 1 + idempotência do vínculo: um identificador só aparece uma vez por workspace.
    identifierUq: uniqueIndex('identity_links_ws_identifier_uq').on(t.workspaceId, t.identifier),
    // lookup reverso: todos os identificadores de um canonical (montar o grafo / stitch).
    canonicalIdx: index('identity_links_ws_canonical_idx').on(t.workspaceId, t.canonicalId),
  }),
);

export const identityMerges = pgTable(
  'identity_merges',
  {
    id: text('id').primaryKey(), // mrg_<ulid>
    workspaceId: text('workspace_id').notNull(),
    /** Canonical VENCEDOR (para o qual o perdedor foi fundido). */
    canonicalId: text('canonical_id').notNull(),
    /** Canonical PERDEDOR (que deixou de existir como raiz após a fusão). */
    mergedFrom: text('merged_from').notNull(),
    /** Motivo legível: `identify:user_id`, `stitch:email_hash`, `stitch:phone_hash`... */
    reason: text('reason').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // regra 1: histórico de merges sempre escopado por workspace + canonical.
    canonicalIdx: index('identity_merges_ws_canonical_idx').on(t.workspaceId, t.canonicalId),
    // varredura por tempo (feed de merges recentes / cursor).
    atIdx: index('identity_merges_ws_at_idx').on(t.workspaceId, t.at),
  }),
);

export type IdentityLink = typeof identityLinks.$inferSelect;
export type NewIdentityLink = typeof identityLinks.$inferInsert;
export type IdentityMerge = typeof identityMerges.$inferSelect;
export type NewIdentityMerge = typeof identityMerges.$inferInsert;
