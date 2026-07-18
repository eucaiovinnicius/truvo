import { z } from 'zod';
import { explorerQuerySpecSchema } from '../compiler/spec';

/**
 * M16 — DTOs do explorador (execução visual + SQL + catálogo).
 *
 * O corpo de /query e /query/preview É o próprio `ExplorerQuerySpec` (validado pelo
 * schema do compilador). `workspace_id`/`is_bot` NÃO existem no DTO de propósito
 * (regra 19): são invariantes injetadas server-side a partir da sessão.
 */

/** POST /v1/explorer/query e /query/preview — corpo = ExplorerQuerySpec. */
export const explorerQueryBodySchema = explorerQuerySpecSchema;
export type ExplorerQueryBodyDto = z.infer<typeof explorerQueryBodySchema>;

/** POST /v1/explorer/sql/validate e /sql — SQL guardado do cliente. */
export const sqlBodySchema = z.object({
  sql: z.string().min(1).max(20_000),
});
export type SqlBodyDto = z.infer<typeof sqlBodySchema>;

/** GET /v1/explorer/catalog?source=events. */
export const catalogQuerySchema = z.object({
  source: z.enum(['events', 'touchpoints']).default('events'),
});
export type CatalogQueryDto = z.infer<typeof catalogQuerySchema>;

/** GET /v1/explorer/catalog/properties?event=purchase&days=30. */
export const propertiesQuerySchema = z.object({
  event: z.string().trim().min(1).max(120).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type PropertiesQueryDto = z.infer<typeof propertiesQuerySchema>;

/** GET /v1/explorer/catalog/values?field=context.utm_source&source=events&limit=50. */
export const valuesQuerySchema = z.object({
  field: z.string().trim().min(1).max(160),
  source: z.enum(['events', 'touchpoints']).default('events'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ValuesQueryDto = z.infer<typeof valuesQuerySchema>;
