import { z } from 'zod';
import { METRIC_KEYS, DIMENSION_KEYS } from '../metrics.constants';

/**
 * DTOs do Dashboard Builder (CRUD /v1/dashboards). `layout` guarda os widgets
 * (grid-12) + filtros globais. Cada widget carrega uma `query` discriminada por
 * `kind`, resolvida server-side em GET /:id/data.
 */

const metricEnum = z.enum(METRIC_KEYS as [string, ...string[]]);
const dimensionEnum = z.enum(DIMENSION_KEYS as [string, ...string[]]);

// Filtros por-widget (segmento; período herda do global se ausente).
const widgetFiltersSchema = z
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
  .strict()
  .optional();

const widgetQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kpis'), filters: widgetFiltersSchema }),
  z.object({
    kind: z.literal('timeseries'),
    metric: metricEnum,
    granularity: z.enum(['day', 'week', 'month']).default('day'),
    filters: widgetFiltersSchema,
  }),
  z.object({
    kind: z.literal('breakdown'),
    metric: metricEnum,
    dimension: dimensionEnum,
    limit: z.number().int().min(1).max(200).default(20),
    filters: widgetFiltersSchema,
  }),
  z.object({
    kind: z.literal('custom_kpi'),
    kpi_ref: z.string().trim().min(1),
    filters: widgetFiltersSchema,
  }),
]);

const widgetSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.enum([
    'kpi_card',
    'line_chart',
    'bar_chart',
    'pie_chart',
    'donut_chart',
    'funnel_chart',
    'table',
    'heatmap',
    'cohort',
  ]),
  title: z.string().max(200).optional(),
  layout: z.object({
    x: z.number().int().min(0).max(12),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(48),
  }),
  query: widgetQuerySchema,
});

const globalFiltersSchema = z
  .object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
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
  .strict()
  .optional();

export const dashboardLayoutSchema = z.object({
  widgets: z.array(widgetSchema).max(60).default([]),
  globalFilters: globalFiltersSchema,
});

export const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  layout: dashboardLayoutSchema.optional(),
});
export type CreateDashboardDto = z.infer<typeof createDashboardSchema>;

export const updateDashboardSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(1000).nullable().optional(),
  layout: dashboardLayoutSchema.optional(),
  /** Liga/desliga o compartilhamento read-only (gera/limpa public_token). */
  is_public: z.boolean().optional(),
});
export type UpdateDashboardDto = z.infer<typeof updateDashboardSchema>;

/** Overrides de janela/segmento globais em GET /:id/data e /public/:token. */
export const dashboardDataQuerySchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  period: z.string().optional(),
});
export type DashboardDataQueryDto = z.infer<typeof dashboardDataQuerySchema>;
