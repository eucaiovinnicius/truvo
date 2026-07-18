import { z } from 'zod';
import { ATTRIBUTION_MODELS, ATTRIBUTION_WINDOWS } from '../attribution.constants';

/**
 * DTOs de LEITURA analítica (GET /v1/attribution/*) + settings (PUT).
 * Zod valida o query string / body. `model`/`window` são enums fechados
 * (allowlist → seguros; nunca viram texto no SQL — o crédito é calculado em TS).
 */

const modelEnum = z.enum(ATTRIBUTION_MODELS as unknown as [string, ...string[]]);

// window chega como texto no query string → coerção + allowlist (1/7/14/30).
const windowSchema = z.coerce
  .number()
  .int()
  .refine((v) => (ATTRIBUTION_WINDOWS as readonly number[]).includes(v), {
    message: `window deve ser um de ${ATTRIBUTION_WINDOWS.join('/')}`,
  });

// Janela de RELATÓRIO (período das conversões) — compartilhada pelos endpoints.
const windowShape = {
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  window: windowSchema.optional(),
};

/** GET /v1/attribution/report */
export const reportQuerySchema = z.object({
  model: modelEnum.optional(),
  ...windowShape,
});
export type ReportQueryDto = z.infer<typeof reportQuerySchema>;

/** GET /v1/attribution/compare — `models` = lista separada por vírgula. */
export const compareQuerySchema = z.object({
  models: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(modelEnum).min(1, 'informe ao menos 1 modelo').max(ATTRIBUTION_MODELS.length),
  ),
  ...windowShape,
});
export type CompareQueryDto = z.infer<typeof compareQuerySchema>;

/** GET /v1/attribution/paths */
export const pathsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  ...windowShape,
});
export type PathsQueryDto = z.infer<typeof pathsQuerySchema>;

/** GET /v1/attribution/campaign-breakdown */
export const campaignBreakdownQuerySchema = z.object({
  model: modelEnum.optional(),
  channel: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  ...windowShape,
});
export type CampaignBreakdownQueryDto = z.infer<typeof campaignBreakdownQuerySchema>;

/** PUT /v1/attribution/settings */
export const updateSettingsSchema = z
  .object({
    default_model: modelEnum.optional(),
    default_window_days: windowSchema.optional(),
    time_decay_half_life_days: z.coerce.number().min(0.1).max(90).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateSettingsDto = z.infer<typeof updateSettingsSchema>;
