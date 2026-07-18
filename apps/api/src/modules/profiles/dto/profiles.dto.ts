import { z } from 'zod';

/**
 * DTOs (zod) do M15 — Customer Profile / User 360. Validados via ZodValidationPipe.
 * Payloads/queries em snake_case (consistente com a API pública e @truvo/event-schema).
 *
 * Nenhum valor do cliente é interpolado em SQL — os enums abaixo (search type,
 * attribution model, group_by, device_type) são allowlists fechadas e os demais
 * valores viram `query_params` no ClickHouse (ver profiles-sql.ts).
 */

// ─────────────────────────────── busca ───────────────────────────────

/**
 * Os 5 tipos de identificador aceitos na busca (PRD §7 M15 "Busca").
 * email_hash/phone_hash chegam JÁ hasheados do cliente (regra 4 — nunca e-mail em
 * claro no backend); user_id/anonymous_id/order_id são as-is.
 */
export const PROFILE_SEARCH_TYPES = [
  'email_hash',
  'phone_hash',
  'user_id',
  'anonymous_id',
  'order_id',
] as const;
export type ProfileSearchType = (typeof PROFILE_SEARCH_TYPES)[number];

/** GET /v1/profiles/search?q=&type= */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'q é obrigatório').max(512),
  type: z.enum(PROFILE_SEARCH_TYPES),
});
export type SearchQueryDto = z.infer<typeof searchQuerySchema>;

// ─────────────────────────────── timeline ───────────────────────────────

/** GET /v1/profiles/:canonicalId/timeline */
export const timelineQuerySchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  event_name: z.string().trim().min(1).max(120).optional(),
  source: z.string().trim().min(1).max(64).optional(),
  device_type: z.enum(['mobile', 'desktop', 'tablet']).optional(),
  /** group_by=day agrupa a página em cabeçalhos de data com contagem por dia. */
  group_by: z.enum(['day']).optional(),
  /** cursor opaco `(timestamp,event_id)` da página anterior (base64). */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TimelineQueryDto = z.infer<typeof timelineQuerySchema>;

// ─────────────────────────────── jornada ───────────────────────────────

/** Modelos de atribuição suportados na jornada (mesma família do M7). */
export const ATTRIBUTION_MODELS = ['last_click', 'first_click', 'linear'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/** GET /v1/profiles/:canonicalId/journey?model=&window= */
export const journeyQuerySchema = z.object({
  model: z.enum(ATTRIBUTION_MODELS).default('last_click'),
  /** Janela de atribuição em dias antes de cada conversão (1..90). */
  window: z.coerce.number().int().min(1).max(90).default(7),
});
export type JourneyQueryDto = z.infer<typeof journeyQuerySchema>;
