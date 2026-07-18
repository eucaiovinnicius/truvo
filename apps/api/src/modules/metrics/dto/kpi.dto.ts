import { z } from 'zod';
import { METRIC_KEYS, DIMENSION_KEYS } from '../metrics.constants';

/**
 * DTOs de KPI customizado (CRUD /v1/kpis). O KPI é uma fórmula visual, SEM SQL do
 * cliente: (numerator / denominator) × multiplier, avaliada no ClickHouse pelo service.
 */

const aggregationEnum = z.enum(['count', 'sum', 'unique']);
const formulaFieldEnum = z.enum(['value', 'order_id', 'user_id', 'session_id', 'anonymous_id']);

/** Um termo da fórmula. `field` é exigido p/ sum|unique (validado no service/refine). */
export const kpiTermSchema = z
  .object({
    event: z.string().trim().min(1).max(120),
    aggregation: aggregationEnum,
    field: formulaFieldEnum.optional(),
  })
  .refine((t) => t.aggregation === 'count' || t.field !== undefined, {
    message: "agregações 'sum' e 'unique' exigem 'field'",
    path: ['field'],
  });

export const kpiFormulaSchema = z.object({
  numerator: kpiTermSchema,
  denominator: kpiTermSchema.optional(),
  multiplier: z.number().finite().optional(),
});

/** Filtros default (período + segmento). Chaves de segmento são allowlist. */
export const kpiFiltersSchema = z
  .object({
    period: z.string().optional(),
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
    device_type: z.string().optional(),
    ip_country: z.string().optional(),
    ip_city: z.string().optional(),
    os: z.string().optional(),
    browser: z.string().optional(),
    source: z.string().optional(),
  })
  .strict();

export const createKpiSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  formula: kpiFormulaSchema,
  filters: kpiFiltersSchema.optional(),
  segment_by: z.array(z.enum(DIMENSION_KEYS as [string, ...string[]])).max(8).optional(),
});
export type CreateKpiDto = z.infer<typeof createKpiSchema>;

export const updateKpiSchema = createKpiSchema.partial();
export type UpdateKpiDto = z.infer<typeof updateKpiSchema>;

/** Overrides de janela/segmento ao avaliar um KPI ad-hoc (GET /v1/kpis/:id/value). */
export const evaluateKpiQuerySchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  period: z.string().optional(),
});
export type EvaluateKpiQueryDto = z.infer<typeof evaluateKpiQuerySchema>;

// Reexport p/ referência do resolver de widgets.
export const KNOWN_METRICS = METRIC_KEYS;
