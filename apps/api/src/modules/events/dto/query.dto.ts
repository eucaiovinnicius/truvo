import { z } from 'zod';

/** GET /v1/events/volume — granularidade + janela opcional (ISO 8601). */
export const volumeQuerySchema = z.object({
  granularity: z.enum(['hour', 'day']).default('day'),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});
export type VolumeQueryDto = z.infer<typeof volumeQuerySchema>;

/** POST /v1/api-keys */
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
