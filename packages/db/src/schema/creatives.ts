import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * M10 — CREATIVE ANALYTICS (schema Postgres, PRD §7 Módulo 10).
 *
 * O CORE analítico do M10 roda no ClickHouse (ddl/09-creatives.sql):
 *   · `creative_daily`      → métricas REPORTADAS pela plataforma (spend, impressões,
 *                             cliques, conversões/receita reportadas) por
 *                             (workspace_id, platform, ad_id, dia). Populado pelo
 *                             sync das Ads APIs (Meta/Google/TikTok).
 *   · `creative_real_daily` → funil/conversões REAIS do Truvo por criativo, derivado
 *                             de `events` (is_bot = 0, regra 11) e cruzado por
 *                             fbclid/gclid/ttclid → ad_id (via utm_content = ad_id).
 *
 * O Postgres guarda apenas o que NÃO é série temporal de alto volume:
 *   1. `creative_ad_accounts` → contas de anúncio conectadas por workspace (o que
 *      sincronizar). Segredos (access tokens) vêm do ENV por plataforma — nunca em
 *      texto puro aqui (regra 7). A linha guarda só config não-secreta + cursor.
 *   2. `creatives`            → CACHE de metadados do criativo (nome, thumbnail,
 *      tipo, fase TOF/MOF/BOF, campanha) por (workspace_id, platform, ad_id).
 *   3. `creative_alert_log`   → histórico/dedup de alertas disparados (fadiga,
 *      discrepância, top performer, gasto sem conversão). A ENTREGA é do M12.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo precisa ser re-exportado por
 * `packages/db/src/schema/index.ts` (barrel) na onda de integração para que
 * `@truvo/db` exponha `creatives`, `creativeAdAccounts`, `creativeAlertLog` e os
 * tipos — MESMO padrão do M5/M6/M7/M8. O barrel NÃO é editado por este módulo
 * (contrato de arquivos) — ver schemaExports/openTODOs.
 *
 * Obs.: `workspace_id` é `text` (não FK) — mesmo padrão do M2..M8 — compatível com
 * o id de workspace do M1. Toda leitura/escrita filtra por `workspace_id` (regra 1).
 */

/** Plataformas de anúncio suportadas no M10 (PRD §7 M10 — fontes de dados). */
export const CREATIVE_PLATFORMS = ['meta', 'google', 'tiktok'] as const;
export type CreativePlatform = (typeof CREATIVE_PLATFORMS)[number];
export const creativePlatformEnum = pgEnum('creative_platform', CREATIVE_PLATFORMS);

/** Fase do funil de mídia do criativo (topo/meio/fundo). */
export const CREATIVE_PHASES = ['TOF', 'MOF', 'BOF', 'unknown'] as const;
export type CreativePhase = (typeof CREATIVE_PHASES)[number];

/** Tipo do criativo (formato do anúncio). */
export const CREATIVE_TYPES = ['image', 'video', 'carousel', 'unknown'] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];

/** Ciclo de vida da conexão de conta de anúncio. */
export const creativeAccountStatusEnum = pgEnum('creative_account_status', [
  'active',
  'inactive',
  'error',
]);

/** Tipos de alerta de criativo (PRD §7 M10 — alertas automáticos). */
export const CREATIVE_ALERT_TYPES = [
  'fatigue', // ROAS real caiu > X% em 7 dias → sugerir pausar
  'discrepancy', // delta reportado vs real > X% → verificar tracking
  'top_performer', // ROAS real > Xx por N dias → aumentar budget
  'spend_no_conversion', // spend > R$X com 0 conversões reais → pausar
] as const;
export type CreativeAlertType = (typeof CREATIVE_ALERT_TYPES)[number];
export const creativeAlertTypeEnum = pgEnum('creative_alert_type', CREATIVE_ALERT_TYPES);

/** Status do alerta (o M12 avança para 'notified'). */
export const creativeAlertStatusEnum = pgEnum('creative_alert_status', [
  'open',
  'notified',
  'resolved',
]);

/**
 * creative_ad_accounts — contas de anúncio que o workspace pediu para sincronizar.
 * O access token de cada plataforma vem do ENV (fail-closed) — a linha guarda só o
 * identificador externo da conta e config não-secreta + o cursor de sync.
 */
export const creativeAdAccounts = pgTable(
  'creative_ad_accounts',
  {
    /** Gerado no serviço: `cra_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono da conexão (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    platform: creativePlatformEnum('platform').notNull(),
    /**
     * Id externo da conta na plataforma: Meta `act_<id>` (ou só o número),
     * Google Ads `customerId`, TikTok `advertiser_id`.
     */
    externalAccountId: text('external_account_id').notNull(),
    name: text('name').notNull().default(''),
    /** Config não-secreta: moeda, timezone, mapeamento de fase por campanha, etc. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: creativeAccountStatusEnum('status').notNull().default('active'),
    /** Último dia sincronizado com sucesso (`YYYY-MM-DD`) — cursor incremental. */
    syncCursor: text('sync_cursor'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('creative_ad_accounts_workspace_idx').on(t.workspaceId),
    // resolução idempotente por (workspace, plataforma, conta externa) no upsert.
    uniqueAccountIdx: index('creative_ad_accounts_unique_idx').on(
      t.workspaceId,
      t.platform,
      t.externalAccountId,
    ),
  }),
);

/**
 * creatives — CACHE de metadados do criativo (uma linha por ad_id por workspace).
 * PK composta (workspace_id, platform, ad_id): idempotente por criativo e escopada
 * por tenant (regra 1). Métricas NÃO vivem aqui — só o "cartão" do criativo para o
 * grid (thumbnail + rótulos) e os enriquecimentos de fase/tipo/campanha.
 */
export const creatives = pgTable(
  'creatives',
  {
    workspaceId: text('workspace_id').notNull(),
    platform: creativePlatformEnum('platform').notNull(),
    /** Id do anúncio na plataforma (ad_id) — chave de cruzamento com as conversões. */
    adId: text('ad_id').notNull(),
    adName: text('ad_name').notNull().default(''),
    campaignId: text('campaign_id').notNull().default(''),
    campaignName: text('campaign_name').notNull().default(''),
    adsetId: text('adset_id').notNull().default(''),
    adsetName: text('adset_name').notNull().default(''),
    creativeType: text('creative_type').$type<CreativeType>().notNull().default('unknown'),
    phase: text('phase').$type<CreativePhase>().notNull().default('unknown'),
    /** URL da thumbnail/preview do criativo (para o grid). */
    thumbnailUrl: text('thumbnail_url').notNull().default(''),
    previewUrl: text('preview_url').notNull().default(''),
    /** Status do anúncio na plataforma (active/paused/…). */
    adStatus: text('ad_status').notNull().default(''),
    /** URL de destino do anúncio (landing). */
    landingUrl: text('landing_url').notNull().default(''),
    /** Recorte não-secreto do objeto original do criativo (auditoria/debug). */
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.platform, t.adId] }),
    // grid: listagem por workspace filtrando por campanha/fase.
    workspaceCampaignIdx: index('creatives_workspace_campaign_idx').on(
      t.workspaceId,
      t.campaignId,
    ),
  }),
);

/**
 * creative_alert_log — histórico de alertas disparados (para dedup + a rota
 * /v1/creatives/alerts retornar o que já foi avaliado). A ENTREGA (email/Slack/
 * in-app) é do M12 (onda futura); aqui só registramos e o M12 avança o status.
 */
export const creativeAlertLog = pgTable(
  'creative_alert_log',
  {
    /** Gerado no serviço: `cal_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    platform: creativePlatformEnum('platform').notNull(),
    adId: text('ad_id').notNull(),
    type: creativeAlertTypeEnum('type').notNull(),
    /** 'info' | 'warning' | 'critical'. */
    severity: text('severity').notNull().default('warning'),
    message: text('message').notNull(),
    /** Detalhes estruturados (limiar, valores observados, janela). */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * Chave de deduplicação: `workspace|platform|adId|type|dayBucket`. Evita
     * re-disparar o mesmo alerta no mesmo dia (o M12 também de-dup, defesa em
     * profundidade).
     */
    dedupKey: text('dedup_key').notNull(),
    status: creativeAlertStatusEnum('status').notNull().default('open'),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
    /** Preenchido pelo M12 quando o alerta é efetivamente notificado. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('creative_alert_log_workspace_idx').on(t.workspaceId, t.triggeredAt),
    // upsert idempotente por dedup_key (não spammar o mesmo alerta).
    dedupIdx: index('creative_alert_log_dedup_idx').on(t.dedupKey),
  }),
);

export type CreativeAdAccount = typeof creativeAdAccounts.$inferSelect;
export type NewCreativeAdAccount = typeof creativeAdAccounts.$inferInsert;
export type Creative = typeof creatives.$inferSelect;
export type NewCreative = typeof creatives.$inferInsert;
export type CreativeAlertRow = typeof creativeAlertLog.$inferSelect;
export type NewCreativeAlertRow = typeof creativeAlertLog.$inferInsert;
