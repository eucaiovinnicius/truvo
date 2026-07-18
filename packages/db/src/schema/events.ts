import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * M2 — EVENT PIPELINE (schema Postgres).
 *
 * `api_keys`: chaves de ingestão por workspace. A chave em claro só existe no
 * momento da criação (retornada uma única vez); persistimos apenas o **hash
 * SHA-256** (regra de negócio 7) + um `prefix` público para exibição na UI.
 *
 * Integração: este arquivo é re-exportado por `packages/db/src/schema/index.ts`
 * (`export * from './events'`) na onda de integração — o barrel já reserva o slot
 * "M2 events: ./events (api_keys)". Só então `apiKeys` fica disponível em `@truvo/db`.
 *
 * Obs.: `workspace_id`/`created_by` são `text` (não FK) para permanecerem
 * compatíveis com o formato de id escolhido pelo M1 (Auth) — que roda em paralelo —
 * e com `workspace_id: z.string()` do @truvo/event-schema. Toda leitura/escrita
 * filtra por `workspace_id` (regra 1).
 */
export const API_KEY_STATUSES = ['active', 'revoked'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    /** SHA-256 hex da chave em claro (regra 7) — nunca guardamos o segredo. */
    keyHash: text('key_hash').notNull(),
    /** Prefixo público p/ exibir (ex.: "tvo_live_a1b2c3d4") — não é segredo. */
    prefix: text('prefix').notNull(),
    /** 'active' | 'revoked'. */
    status: text('status').notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    keyHashUq: uniqueIndex('api_keys_key_hash_uq').on(t.keyHash),
    workspaceIdx: index('api_keys_workspace_idx').on(t.workspaceId),
  }),
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
