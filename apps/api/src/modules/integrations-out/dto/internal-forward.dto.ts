import { z } from 'zod';

/**
 * Payload do endpoint INTERNO de forward de conversão (server-to-server).
 * Espelha `ConversionForwardInput` (conversion-forwarder.service.ts) em camelCase —
 * o consumer do M2 monta isto a partir do TruvoEvent de conversão ENQUANTO a PII
 * viva ainda existe (regra 4/5). Sem `consent.granted` nenhuma PII é enviada (regra 13).
 */
export const internalForwardSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  timestampMs: z.number().optional(),
  value: z.number().optional(),
  currency: z.string().optional(),
  sourceUrl: z.string().optional(),
  orderId: z.string().optional(),
  consent: z.object({
    granted: z.boolean(),
    adUserData: z.boolean().optional(),
    adPersonalization: z.boolean().optional(),
  }),
  matchKeys: z.object({
    email: z.string().optional(),
    phone: z.string().optional(),
    clickId: z.string().optional(),
    fbclid: z.string().optional(),
    gclid: z.string().optional(),
    ttclid: z.string().optional(),
    fbp: z.string().optional(),
    externalId: z.string().optional(),
    ip: z.string().optional(),
    userAgent: z.string().optional(),
  }),
  platforms: z.array(z.string()).optional(),
});

export type InternalForwardDto = z.infer<typeof internalForwardSchema>;
