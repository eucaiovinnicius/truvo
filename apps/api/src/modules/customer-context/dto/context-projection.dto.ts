import { z } from 'zod';

/**
 * POST /v1/internal/context/project (server-to-server, consumer M2 → Order 040
 * projection). Mesmo padrão do M8/M9 internos: `workspace_id` e o `canonical_id`
 * JÁ resolvido (pelo forward de identify que roda antes, no consumer) vêm no corpo
 * — este endpoint nunca refaz resolução de identidade (Identity Graph v2 fora de
 * escopo). `event` carrega só os campos que a projeção lê; não é o EventSchema
 * inteiro (a validação completa já aconteceu na ingestão/M2).
 */
export const internalProjectEventSchema = z.object({
  event_id: z.string().min(1),
  event_name: z.string().min(1),
  order_id: z.string().optional(),
  timestamp: z.string().optional(),
  properties: z.record(z.unknown()).default({}),
});

export const internalProjectSchema = z.object({
  workspace_id: z.string().min(1).max(255),
  canonical_id: z.string().min(1),
  event: internalProjectEventSchema,
});
export type InternalProjectDto = z.infer<typeof internalProjectSchema>;
