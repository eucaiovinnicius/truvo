import { z } from 'zod';
import { ingestEventSchema } from '@truvo/event-schema';

/**
 * DTO de ingestão. Reusa `ingestEventSchema` (@truvo/event-schema) mas torna
 * `workspace_id` opcional: o workspace vem SEMPRE do ApiKeyGuard (regra 1), o
 * cliente nunca o informa. Um `workspace_id` no corpo é ignorado/sobrescrito.
 */
export const apiIngestSchema = ingestEventSchema.partial({ workspace_id: true });
export type ApiIngestDto = z.infer<typeof apiIngestSchema>;

/** Batch: array de eventos, 1..500 (PRD §7 M2). */
export const apiBatchSchema = z.array(apiIngestSchema).min(1).max(500);
export type ApiBatchDto = z.infer<typeof apiBatchSchema>;
