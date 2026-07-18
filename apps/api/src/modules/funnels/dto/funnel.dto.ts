import { z } from 'zod';

/**
 * DTOs do M5 — Funnel Engine (validados via ZodValidationPipe).
 * Payloads em snake_case (consistente com @truvo/event-schema e a API pública).
 */

// ── Condições de step ────────────────────────────────────────────────────────
const propertyEqSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.union([z.string().max(500), z.number(), z.boolean()]),
});

const propertyGteSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.number(),
});

const stepConditionsSchema = z
  .object({
    url_contains: z.string().min(1).max(500).optional(),
    element_id: z.string().min(1).max(200).optional(),
    property_eq: propertyEqSchema.optional(),
    property_gte: propertyGteSchema.optional(),
  })
  .strict()
  .default({});

const stepSchema = z.object({
  /** Opcional na entrada — gerado (`s<n>`) se ausente. */
  step_id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  event: z.string().min(1).max(120),
  conditions: stepConditionsSchema,
});
export type FunnelStepInput = z.infer<typeof stepSchema>;

// ── Alerta ───────────────────────────────────────────────────────────────────
export const alertConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    min_overall_conversion_rate: z.number().min(0).max(100).default(0),
    channels: z.array(z.enum(['email', 'slack', 'in_app'])).optional(),
  })
  .strict();
export type AlertConfigDto = z.infer<typeof alertConfigSchema>;

// ── CRUD ─────────────────────────────────────────────────────────────────────
const funnelStatusSchema = z.enum(['active', 'archived', 'draft']);

export const createFunnelSchema = z.object({
  name: z.string().min(1).max(200),
  status: funnelStatusSchema.default('active'),
  attribution_window_days: z.number().int().min(1).max(90).default(7),
  steps: z.array(stepSchema).min(2, 'um funil precisa de ao menos 2 steps').max(20),
  alert: alertConfigSchema.optional(),
});
export type CreateFunnelDto = z.infer<typeof createFunnelSchema>;

export const updateFunnelSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: funnelStatusSchema.optional(),
    attribution_window_days: z.number().int().min(1).max(90).optional(),
    steps: z.array(stepSchema).min(2, 'um funil precisa de ao menos 2 steps').max(20).optional(),
    alert: alertConfigSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateFunnelDto = z.infer<typeof updateFunnelSchema>;

// ── Query de stats / dropoff ─────────────────────────────────────────────────
/** Query string chega como texto; interpretamos 'true'/'1' como booleano. */
const booleanish = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' || v === '1' : v),
  z.boolean(),
);

export const funnelFiltersSchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  utm_source: z.string().max(255).optional(),
  utm_medium: z.string().max(255).optional(),
  device_type: z.enum(['mobile', 'desktop', 'tablet']).optional(),
  ip_country: z.string().max(64).optional(),
});
export type FunnelFiltersDto = z.infer<typeof funnelFiltersSchema>;

export const statsQuerySchema = funnelFiltersSchema.extend({
  /** compare=true → inclui o período anterior de mesma duração p/ delta. */
  compare: booleanish.optional(),
});
export type StatsQueryDto = z.infer<typeof statsQuerySchema>;

export const dropoffQuerySchema = funnelFiltersSchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** format=csv → controller responde text/csv. */
  format: z.enum(['json', 'csv']).default('json'),
});
export type DropoffQueryDto = z.infer<typeof dropoffQuerySchema>;
