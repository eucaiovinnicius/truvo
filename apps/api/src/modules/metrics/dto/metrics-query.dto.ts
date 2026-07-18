import { z } from 'zod';
import { METRIC_KEYS, DIMENSION_KEYS } from '../metrics.constants';

/**
 * DTOs de LEITURA analítica (GET /v1/metrics/*). Zod valida o query string.
 * `metric`/`dimension`/`granularity` são enums fechados (allowlist → seguros no SQL).
 */

// Janela (start/end ISO ou period relativo) — compartilhada pelos 3 endpoints.
const windowShape = {
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  period: z.string().optional(),
};

// Filtros de segmento (allowlist de colunas achatadas de `events`) — todos opcionais.
const segmentShape = {
  utm_source: z.string().trim().min(1).optional(),
  utm_medium: z.string().trim().min(1).optional(),
  utm_campaign: z.string().trim().min(1).optional(),
  utm_content: z.string().trim().min(1).optional(),
  utm_term: z.string().trim().min(1).optional(),
  device_type: z.string().trim().min(1).optional(),
  ip_country: z.string().trim().min(1).optional(),
  ip_city: z.string().trim().min(1).optional(),
  os: z.string().trim().min(1).optional(),
  browser: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
};

/** GET /v1/metrics/kpis */
export const kpisQuerySchema = z.object({ ...windowShape, ...segmentShape });
export type KpisQueryDto = z.infer<typeof kpisQuerySchema>;

/** GET /v1/metrics/timeseries */
export const timeseriesQuerySchema = z.object({
  metric: z.enum(METRIC_KEYS as [string, ...string[]]).default('events'),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  ...windowShape,
  ...segmentShape,
});
export type TimeseriesQueryDto = z.infer<typeof timeseriesQuerySchema>;

/** GET /v1/metrics/breakdown */
export const breakdownQuerySchema = z.object({
  metric: z.enum(METRIC_KEYS as [string, ...string[]]).default('revenue'),
  dimension: z.enum(DIMENSION_KEYS as [string, ...string[]]).default('utm_source'),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  ...windowShape,
  ...segmentShape,
});
export type BreakdownQueryDto = z.infer<typeof breakdownQuerySchema>;
