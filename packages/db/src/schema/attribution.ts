import { integer, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * M7 — ATTRIBUTION ENGINE (schema Postgres, PRD §7 Módulo 7).
 *
 * Toda a LEITURA analítica de atribuição roda no ClickHouse sobre a tabela
 * `touchpoints` (05-identity.sql) e `events` (02-events.sql), SEMPRE com
 * `workspace_id` no WHERE e `is_bot = 0` (regras 1 e 11). O crédito por
 * touchpoint (last_click / first_click / linear / position_based / time_decay)
 * é calculado na camada de aplicação a partir dos caminhos de conversão — ver
 * apps/api/src/modules/attribution.
 *
 * A ÚNICA coisa persistida em Postgres é a CONFIGURAÇÃO por workspace: o modelo
 * default, a janela de atribuição default (1/7/14/30 dias) e a meia-vida do
 * time-decay. Isso torna a atribuição "configurável por workspace" (PRD §7 M7)
 * sem acoplar a config ao caminho quente do ClickHouse.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo precisa ser re-exportado por
 * `packages/db/src/schema/index.ts` (barrel) na onda de integração para que
 * `@truvo/db` exponha `attributionSettings` e os tipos — MESMO padrão do M5/M6/M8.
 * O barrel NÃO é editado por este módulo (contrato de arquivos) — ver openTODOs.
 *
 * Obs.: `workspace_id` é `text` (não FK) — mesmo padrão do M2..M6 — para
 * permanecer compatível com o formato de id do M1 (Auth) e com
 * `workspace_id: z.string()` do @truvo/event-schema. Toda leitura/escrita filtra
 * por `workspace_id` (regra 1).
 */

/** Modelos de atribuição suportados (PRD §7 M7). Fonte de verdade compartilhada. */
export const ATTRIBUTION_MODELS = [
  'last_click',
  'first_click',
  'linear',
  'position_based',
  'time_decay',
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/** Janelas de atribuição permitidas, em dias (PRD §7 M7). */
export const ATTRIBUTION_WINDOWS = [1, 7, 14, 30] as const;
export type AttributionWindowDays = (typeof ATTRIBUTION_WINDOWS)[number];

/** Defaults de fábrica quando um workspace ainda não tem linha de settings. */
export const ATTRIBUTION_DEFAULTS = {
  model: 'last_click' as AttributionModel,
  windowDays: 7,
  timeDecayHalfLifeDays: 7,
} as const;

/**
 * attribution_settings — 1 linha por workspace com a config de atribuição.
 * `default_model` é `text` (não pgEnum) de propósito: evita criar um tipo enum
 * do Postgres neste módulo (o serviço valida contra ATTRIBUTION_MODELS via zod
 * antes de gravar — allowlist).
 */
export const attributionSettings = pgTable('attribution_settings', {
  /** Tenant dono da config (regra 1). PK = 1 linha por workspace. */
  workspaceId: text('workspace_id').primaryKey(),
  /** Modelo default aplicado quando o request não passa `model`. */
  defaultModel: text('default_model').$type<AttributionModel>().notNull().default('last_click'),
  /** Janela default (dias) aplicada quando o request não passa `window`. */
  defaultWindowDays: integer('default_window_days').notNull().default(7),
  /** Meia-vida (dias) do time-decay: λ = ln(2) / half_life. */
  timeDecayHalfLifeDays: real('time_decay_half_life_days').notNull().default(7),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AttributionSettings = typeof attributionSettings.$inferSelect;
export type NewAttributionSettings = typeof attributionSettings.$inferInsert;
