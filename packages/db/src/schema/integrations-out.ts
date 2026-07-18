import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * M9 — EXTERNAL INTEGRATIONS (SAÍDA DE DADOS) · schema Postgres (PRD §7 Módulo 9).
 *
 * Envio server-side de conversões (purchase/lead/InitiateCheckout/CompleteRegistration)
 * para plataformas de anúncios: Meta Conversions API, Google Enhanced Conversions e
 * TikTok Events API. Duas tabelas:
 *
 *   · integration_out_configs → configuração/credenciais POR workspace e POR plataforma
 *                               (1 linha por (workspace_id, platform)). Credenciais SEMPRE
 *                               cifradas em repouso (AES-256-GCM, regra 7 / §12).
 *   · integration_out_logs    → auditoria de CADA tentativa de envio: evento, dedup por
 *                               event_id, status, match keys presentes (só flags, sem PII),
 *                               proxy de Event Match Quality e a resposta resumida da
 *                               plataforma (fbtrace_id/events_received — nunca PII).
 *
 * Regras de negócio respeitadas:
 *   1  — toda leitura/escrita filtra por workspace_id (índices abaixo);
 *   4/7 — nenhum e-mail/telefone/segredo em texto puro. As match keys hasheadas viajam
 *         para a plataforma mas NUNCA são persistidas nos logs (só flags de presença);
 *         credenciais ficam cifradas em `credentials_encrypted`.
 *   5  — IP bruto pode ser usado como match key no ENVIO (dado vivo do evento), mas
 *         NUNCA é persistido (nem nos logs).
 *   13 — envio de PII a terceiros exige base legal + consentimento. Sem consentimento
 *         válido o forwarder registra `skipped_no_consent` e NÃO envia.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado pelo barrel
 * `packages/db/src/schema/index.ts` (`export * from './integrations-out'`) na onda de
 * integração para que `@truvo/db` exponha `integrationOutConfigs`, `integrationOutLogs`
 * e os enums. O barrel NÃO é editado por este módulo (contrato de arquivos) — reportado
 * em `schemaExports`/`openTODOs`.
 *
 * Obs.: `workspace_id` é `text` (não FK) — mesmo padrão do M2/M4/M8 — para permanecer
 * compatível com o formato de id do M1 (Auth) e com `workspace_id: z.string()` do
 * @truvo/event-schema.
 */

// ─────────────────────────── enums ───────────────────────────

/** Plataformas de saída suportadas no MVP (PRD §7 M9). */
export const INTEGRATION_OUT_PLATFORMS = [
  'meta_capi', // Meta Conversions API
  'google_enhanced', // Google Enhanced Conversions (Google Ads API)
  'tiktok_events', // TikTok Events API
] as const;
export type IntegrationOutPlatform = (typeof INTEGRATION_OUT_PLATFORMS)[number];
export const integrationOutPlatformEnum = pgEnum(
  'integration_out_platform',
  INTEGRATION_OUT_PLATFORMS,
);

/** Ciclo de vida de uma configuração de saída. */
export const INTEGRATION_OUT_STATUSES = [
  'pending', // criada, credenciais ainda não validadas
  'active', // habilitada e validada
  'inactive', // desabilitada manualmente
  'error', // último envio/teste falhou (ver last_error)
] as const;
export type IntegrationOutStatus = (typeof INTEGRATION_OUT_STATUSES)[number];
export const integrationOutStatusEnum = pgEnum(
  'integration_out_status',
  INTEGRATION_OUT_STATUSES,
);

/**
 * Resultado de uma tentativa de envio (auditoria + monitor).
 *  · sent                  — plataforma aceitou (2xx).
 *  · failed                — erro de rede / 4xx-5xx da plataforma.
 *  · skipped_no_consent    — regra 13: sem base legal/consentimento → não enviou.
 *  · skipped_no_match_keys — nenhuma match key utilizável → envio inútil, pulado.
 *  · skipped_unmapped      — o evento não mapeia para um evento de conversão da plataforma.
 *  · skipped_duplicate     — já havia envio 'sent' p/ (workspace, platform, event_id).
 *  · skipped_disabled      — plataforma não configurada/desabilitada p/ o workspace.
 */
export const INTEGRATION_OUT_LOG_STATUSES = [
  'sent',
  'failed',
  'skipped_no_consent',
  'skipped_no_match_keys',
  'skipped_unmapped',
  'skipped_duplicate',
  'skipped_disabled',
] as const;
export type IntegrationOutLogStatus = (typeof INTEGRATION_OUT_LOG_STATUSES)[number];
export const integrationOutLogStatusEnum = pgEnum(
  'integration_out_log_status',
  INTEGRATION_OUT_LOG_STATUSES,
);

// ─────────────────────── tipos JSONB (fonte de verdade) ───────────────────────

/**
 * Config NÃO-secreta por plataforma. Campos usados variam por plataforma:
 *  · Meta:   pixel_id (obrigatório), test_event_code (opcional), graph_version.
 *  · Google: customer_id, login_customer_id, conversion_actions (canonical→resource),
 *            conversion_action_id (fallback único).
 *  · TikTok: pixel_code (obrigatório), test_event_code (opcional).
 * `event_map` sobrescreve o mapeamento evento Truvo → conversão canônica.
 */
export interface IntegrationOutConfigJson {
  /** Meta pixel/dataset id. */
  pixel_id?: string;
  /** TikTok pixel code. */
  pixel_code?: string;
  /** Google Ads customer id (sem hífens). */
  customer_id?: string;
  /** Google login-customer-id (MCC), quando aplicável. */
  login_customer_id?: string;
  /** Google: canonical (purchase/lead/...) → conversionAction resource name. */
  conversion_actions?: Record<string, string>;
  /** Google: conversion action único (fallback quando não há mapa). */
  conversion_action_id?: string;
  /** Código de evento de teste (Meta/TikTok) — dry-run no Events Manager. */
  test_event_code?: string;
  /** Versão da Graph API (Meta) — default no client. */
  graph_version?: string;
  /** Sobrescreve evento Truvo → conversão canônica ('ignore' descarta). */
  event_map?: Record<string, string>;
  [key: string]: unknown;
}

/** Flags de presença das match keys enviadas — SEM PII (regra 4/7). */
export interface MatchKeyFlags {
  email?: boolean;
  phone?: boolean;
  click_id?: boolean; // fbc/gclid/ttclid conforme a plataforma
  external_id?: boolean;
  ip?: boolean;
  user_agent?: boolean;
}

// ─────────────────────────── tabelas ───────────────────────────

export const integrationOutConfigs = pgTable(
  'integration_out_configs',
  {
    id: text('id').primaryKey(), // iout_<ulid>
    workspaceId: text('workspace_id').notNull(),
    platform: integrationOutPlatformEnum('platform').notNull(),
    /** Habilita o envio automático no fluxo de conversão. */
    enabled: boolean('enabled').notNull().default(false),
    /**
     * Segredos cifrados (AES-256-GCM), blob `v1.<iv>.<tag>.<ct>` (base64) de um JSON:
     *   Meta   → { access_token }
     *   Google → { developer_token, client_id, client_secret, refresh_token }
     *   TikTok → { access_token }
     * NUNCA guardar segredo em texto puro (regra 7 / §12).
     */
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    /** Config não-secreta (pixel_id, customer_id, conversion_actions, test_event_code…). */
    config: jsonb('config')
      .$type<IntegrationOutConfigJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Base legal exige consentimento (regra 13). Mantido `true` por padrão; o forwarder
     * fail-closed exige consentimento válido no evento antes de enviar PII.
     */
    consentRequired: boolean('consent_required').notNull().default(true),
    status: integrationOutStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    lastForwardAt: timestamp('last_forward_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 1 config por plataforma por workspace (regra 1 + upsert idempotente).
    wsPlatformUnique: uniqueIndex('integration_out_configs_ws_platform_uq').on(
      t.workspaceId,
      t.platform,
    ),
    workspaceIdx: index('integration_out_configs_workspace_idx').on(t.workspaceId),
  }),
);

export const integrationOutLogs = pgTable(
  'integration_out_logs',
  {
    id: text('id').primaryKey(), // iol_<ulid>
    workspaceId: text('workspace_id').notNull(),
    platform: integrationOutPlatformEnum('platform').notNull(),
    /** event_id do Truvo — chave de dedup pixel+CAPI e de idempotência do reenvio. */
    eventId: text('event_id').notNull(),
    /** Evento Truvo de origem (purchase/lead/…). */
    eventName: text('event_name'),
    /** Evento mapeado enviado à plataforma (Purchase/Lead/CompletePayment…). */
    platformEvent: text('platform_event'),
    status: integrationOutLogStatusEnum('status').notNull(),
    httpStatus: integer('http_status'),
    /**
     * Proxy local de Event Match Quality (0–10): cobertura ponderada das match keys.
     * O EMQ REAL é computado pela plataforma depois; guardamos a resposta em `response`.
     */
    matchQuality: real('match_quality'),
    /** Nº de match keys presentes. */
    matchKeysCount: integer('match_keys_count').notNull().default(0),
    /** Flags de presença das match keys — SEM PII (regra 4/7). */
    matchKeys: jsonb('match_keys').$type<MatchKeyFlags>().notNull().default(sql`'{}'::jsonb`),
    /** Valor/moeda da conversão (agregado do pedido, não é PII). */
    value: doublePrecision('value'),
    currency: text('currency'),
    error: text('error'),
    /** Resposta resumida da plataforma (fbtrace_id, events_received…). SEM PII. */
    response: jsonb('response').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Dedup server-side: já existe envio 'sent' p/ (workspace, platform, event_id)?
    dedupIdx: index('integration_out_logs_dedup_idx').on(
      t.workspaceId,
      t.platform,
      t.eventId,
    ),
    // Monitor de EMQ / listagem por plataforma no tempo.
    monitorIdx: index('integration_out_logs_monitor_idx').on(
      t.workspaceId,
      t.platform,
      t.createdAt,
    ),
  }),
);

export type IntegrationOutConfig = typeof integrationOutConfigs.$inferSelect;
export type NewIntegrationOutConfig = typeof integrationOutConfigs.$inferInsert;
export type IntegrationOutLog = typeof integrationOutLogs.$inferSelect;
export type NewIntegrationOutLog = typeof integrationOutLogs.$inferInsert;
