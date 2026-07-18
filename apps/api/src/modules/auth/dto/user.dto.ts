import { z } from 'zod';

/** PATCH /v1/users/me — ao menos um campo. */
export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    avatar_url: z.string().url().max(2048).optional(),
  })
  .refine((v) => v.name !== undefined || v.avatar_url !== undefined, {
    message: 'informe ao menos um campo (name ou avatar_url)',
  });
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
