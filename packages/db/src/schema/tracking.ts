import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * M3 — Tracking Layer (PRD §7 Módulo 3, §8).
 *
 * tracking_links: links rastreados (`/c/:code`) com UTMs configuráveis e contador
 * de cliques. `code` é global (o redirect público resolve code → link → workspace),
 * portanto o unique é sobre `code` isolado — mas TODA leitura por workspace filtra
 * `workspace_id` (regra 1 do PRD).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo é re-exportado no barrel `schema/index.ts`
 * (`export * from './tracking'`) durante a integração da onda M3 — ver openTODOs.
 */
export const trackingLinks = pgTable(
  'tracking_links',
  {
    /** ULID gerado na aplicação (ver TrackingService). */
    id: text('id').primaryKey(),
    /** Tenant dono do link (regra 1 — isolamento multi-tenant). */
    workspaceId: text('workspace_id').notNull(),
    /** Código curto usado em `/c/:code` (nanoid). Único globalmente. */
    code: text('code').notNull(),
    /** URL de destino do redirect. */
    destinationUrl: text('destination_url').notNull(),
    /** Rótulo humano opcional (ex.: "Campanha Maio - Story"). */
    label: text('label'),
    /** UTMs configuráveis — aplicadas ao destino no redirect. */
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    /** Contador de cliques (autoritativo p/ stats.clicks). */
    clickCount: integer('click_count').notNull().default(0),
    /** Soft-delete: DELETE marca active=false → `/c/:code` para de resolver. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex('tracking_links_code_unique').on(t.code),
    workspaceIdx: index('tracking_links_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

export type TrackingLink = typeof trackingLinks.$inferSelect;
export type NewTrackingLink = typeof trackingLinks.$inferInsert;
