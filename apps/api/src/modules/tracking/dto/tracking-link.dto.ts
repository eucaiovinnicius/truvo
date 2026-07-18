import { z } from 'zod';

/**
 * DTOs de tracking links validados com zod (via ZodValidationPipe — regra do projeto:
 * zod, NÃO class-validator).
 */

const utm = z.string().trim().min(1).max(200).optional();

export const createTrackingLinkSchema = z.object({
  /** Destino do redirect. Precisa ser URL absoluta (http/https). */
  destination_url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'destination_url deve ser http(s)'),
  /** Código curto opcional; se ausente é gerado com nanoid. URL-safe. */
  code: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'code aceita apenas [A-Za-z0-9_-]')
    .optional(),
  label: z.string().trim().max(200).optional(),
  utm_source: utm,
  utm_medium: utm,
  utm_campaign: utm,
  utm_content: utm,
  utm_term: utm,
});
export type CreateTrackingLinkDto = z.infer<typeof createTrackingLinkSchema>;

/** PATCH — todos os campos opcionais; `active` permite reativar um link. */
export const updateTrackingLinkSchema = createTrackingLinkSchema
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateTrackingLinkDto = z.infer<typeof updateTrackingLinkSchema>;
