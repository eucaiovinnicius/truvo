import { z } from 'zod';
import { EVENT_SOURCES } from '@truvo/event-schema';

/**
 * DTOs (zod) do M8. Validados via ZodValidationPipe.
 *
 * Os tipos de identificador espelham `identifierTypeEnum` de
 * `packages/db/src/schema/identity.ts` — mantidos aqui como tupla própria porque
 * o valor RUNTIME do enum só chega em `@truvo/db` após a integração do barrel
 * (mesma convenção do M2/M3/M4). Manter em sincronia com o schema.
 */
export const IDENTIFIER_TYPES = [
  'click_id',
  'anonymous_id',
  'user_id',
  'email_hash',
  'phone_hash',
  'order_id',
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** GET /v1/identity/lookup?identifier=&type= */
export const lookupQuerySchema = z.object({
  identifier: z.string().min(1).max(512),
  type: z.enum(IDENTIFIER_TYPES),
});
export type LookupQueryDto = z.infer<typeof lookupQuerySchema>;

/** Contexto de canal/UTM opcional — quando presente, vira um touchpoint (M7). */
export const identifyContextSchema = z
  .object({
    channel: z.string().max(64).optional(),
    utm_source: z.string().max(255).optional(),
    utm_medium: z.string().max(255).optional(),
    utm_campaign: z.string().max(255).optional(),
  })
  .partial();
export type IdentifyContextDto = z.infer<typeof identifyContextSchema>;

/**
 * POST /v1/identity/identify — trigger de stitching.
 *
 * Aceita `email`/`phone` em claro (hasheados no servidor — regra 4) OU já
 * `email_hash`/`phone_hash`. `source` alimenta a prioridade de dedup do M2 no
 * toque de conversão (regra 2/10). Exige pelo menos UM identificador.
 */
export const identifySchema = z
  .object({
    anonymous_id: z.string().min(1).max(255).optional(),
    user_id: z.string().min(1).max(255).optional(),
    email: z.string().email().max(320).optional(),
    email_hash: z.string().regex(/^[a-f0-9]{64}$/i, 'email_hash deve ser SHA-256 hex').optional(),
    phone: z.string().min(3).max(32).optional(),
    phone_hash: z.string().regex(/^[a-f0-9]{64}$/i, 'phone_hash deve ser SHA-256 hex').optional(),
    click_id: z.string().min(1).max(255).optional(),
    order_id: z.string().min(1).max(255).optional(),
    source: z.enum(EVENT_SOURCES).optional(),
    context: identifyContextSchema.optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.anonymous_id ||
          v.user_id ||
          v.email ||
          v.email_hash ||
          v.phone ||
          v.phone_hash ||
          v.click_id ||
          v.order_id,
      ),
    { message: 'informe ao menos um identificador (anonymous_id, user_id, email, ...)' },
  );
export type IdentifyDto = z.infer<typeof identifySchema>;

/** GET /v1/identity/merges?canonical_id=&limit=&cursor= */
export const mergesQuerySchema = z.object({
  canonical_id: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** cursor = ISO 8601 do último `at` visto (paginação desc por tempo). */
  cursor: z.string().datetime().optional(),
});
export type MergesQueryDto = z.infer<typeof mergesQuerySchema>;
