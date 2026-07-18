import { z } from 'zod';
import { INTEGRATION_OUT_PLATFORMS } from '@truvo/db';

/**
 * M9 — DTOs (validados via ZodValidationPipe). Credenciais chegam em texto puro no
 * corpo (HTTPS) e são cifradas (AES-256-GCM) ANTES de persistir; nunca retornam.
 */

/** Enum de plataforma como zod (reusa a fonte de verdade do @truvo/db). */
export const platformSchema = z.enum(INTEGRATION_OUT_PLATFORMS);
export type PlatformParam = z.infer<typeof platformSchema>;

/** Param de rota `:platform`. */
export const platformParamSchema = z.object({ platform: platformSchema });
export type PlatformParamDto = z.infer<typeof platformParamSchema>;

/**
 * Segredos por plataforma. Não exigimos todos aqui (a validação de completude é do
 * client no ping); apenas garantimos que pelo menos um segredo foi enviado.
 */
export const credentialsSchema = z
  .object({
    access_token: z.string().min(1).optional(), // Meta / TikTok
    developer_token: z.string().min(1).optional(), // Google
    client_id: z.string().min(1).optional(), // Google OAuth
    client_secret: z.string().min(1).optional(), // Google OAuth
    refresh_token: z.string().min(1).optional(), // Google OAuth
  })
  .passthrough()
  .refine((c) => Object.values(c).some((v) => typeof v === 'string' && v.length > 0), {
    message: 'credenciais devem conter ao menos um segredo (access_token/developer_token/…)',
  });

/** Config não-secreta por plataforma. */
export const configSchema = z
  .object({
    pixel_id: z.string().max(120).optional(),
    pixel_code: z.string().max(120).optional(),
    customer_id: z.string().max(40).optional(),
    login_customer_id: z.string().max(40).optional(),
    conversion_action_id: z.string().max(255).optional(),
    conversion_actions: z.record(z.string()).optional(),
    test_event_code: z.string().max(120).optional(),
    graph_version: z.string().max(12).optional(),
    event_map: z.record(z.string()).optional(),
  })
  .passthrough();

/** PUT /:platform — cria/atualiza a config da plataforma (upsert). */
export const upsertConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    credentials: credentialsSchema.optional(),
    config: configSchema.optional(),
    status: z.enum(['pending', 'active', 'inactive', 'error']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpsertConfigDto = z.infer<typeof upsertConfigSchema>;

/**
 * POST /:platform/test — envio de conversão de teste. Aceita match keys opcionais
 * para exercitar a montagem do payload; sem elas, o teste valida só credenciais.
 * O consentimento é implícito (ação administrativa manual do dono da conta).
 */
export const testConversionSchema = z.object({
  event_name: z.string().min(1).max(60).default('purchase'),
  value: z.coerce.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  email: z.string().max(320).optional(), // claro ou já hash — o serviço normaliza
  phone: z.string().max(40).optional(),
  click_id: z.string().max(512).optional(),
  external_id: z.string().max(255).optional(),
});
export type TestConversionDto = z.infer<typeof testConversionSchema>;

/** GET /logs — filtro do monitor de EMQ. */
export const logsQuerySchema = z.object({
  status: z
    .enum([
      'sent',
      'failed',
      'skipped_no_consent',
      'skipped_no_match_keys',
      'skipped_unmapped',
      'skipped_duplicate',
      'skipped_disabled',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LogsQuery = z.infer<typeof logsQuerySchema>;
