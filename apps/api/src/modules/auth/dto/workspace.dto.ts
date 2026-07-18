import { z } from 'zod';

const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug: minúsculas, dígitos e hífens');

/** POST /v1/workspaces */
export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema.optional(),
  logo_url: z.string().url().max(2048).optional(),
  timezone: z.string().min(1).max(64).default('America/Sao_Paulo'),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'currency: ISO-4217 (ex.: BRL)')
    .default('BRL'),
  data_retention_days: z.number().int().min(1).max(3650).default(730),
});
export type CreateWorkspaceDto = z.infer<typeof createWorkspaceSchema>;

/** PATCH /v1/workspaces/:id — ao menos um campo. */
export const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: slugSchema.optional(),
    logo_url: z.string().url().max(2048).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .optional(),
    data_retention_days: z.number().int().min(1).max(3650).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'informe ao menos um campo' });
export type UpdateWorkspaceDto = z.infer<typeof updateWorkspaceSchema>;
