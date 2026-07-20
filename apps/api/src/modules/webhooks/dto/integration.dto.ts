import { z } from 'zod';
import { WEBHOOK_PROVIDERS } from '../constants';

/**
 * DTOs de gerência de integrações (validados via ZodValidationPipe, não
 * class-validator). As credenciais chegam em texto puro no corpo (HTTPS) e são
 * cifradas (AES-256-GCM) ANTES de persistir — nunca retornam nas respostas.
 */

const integrationStatusSchema = z.enum(['pending', 'active', 'inactive', 'error']);

/**
 * Segredos do provedor. Exigimos ao menos um segredo de assinatura HMAC
 * (`hmac_secret` ou `signing_secret`); campos extras são aceitos (api_key etc.).
 */
export const credentialsSchema = z
  .object({
    hmac_secret: z.string().min(1).optional(),
    signing_secret: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    hottok: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(), // HubSpot (app client secret)
    api_key: z.string().min(1).optional(),
    api_secret: z.string().min(1).optional(),
  })
  .passthrough()
  .refine(
    (c) => Boolean(c.hmac_secret ?? c.signing_secret ?? c.secret ?? c.hottok ?? c.client_secret),
    { message: 'credenciais devem conter um segredo de assinatura (hmac_secret/signing_secret/secret/hottok/client_secret)' },
  );

export const createIntegrationSchema = z.object({
  type: z.enum(WEBHOOK_PROVIDERS),
  name: z.string().min(1).max(120),
  external_id: z.string().max(255).optional(),
  credentials: credentialsSchema,
  config: z.record(z.unknown()).optional(),
  status: integrationStatusSchema.optional(),
});
export type CreateIntegrationDto = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    external_id: z.string().max(255).nullable().optional(),
    credentials: credentialsSchema.optional(),
    config: z.record(z.unknown()).optional(),
    status: integrationStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateIntegrationDto = z.infer<typeof updateIntegrationSchema>;

export const listIntegrationsQuerySchema = z.object({
  type: z.enum(WEBHOOK_PROVIDERS).optional(),
  status: integrationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListIntegrationsQuery = z.infer<typeof listIntegrationsQuerySchema>;

export const logsQuerySchema = z.object({
  status: z
    .enum(['received', 'verified', 'processed', 'failed', 'rejected', 'retrying'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LogsQuery = z.infer<typeof logsQuerySchema>;
