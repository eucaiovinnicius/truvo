import { z } from 'zod';

/** POST /v1/auth/signup */
export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'senha deve ter ao menos 8 caracteres').max(72),
  name: z.string().min(1).max(120).optional(),
});
export type SignupDto = z.infer<typeof signupSchema>;

/** POST /v1/auth/login */
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof loginSchema>;

/** POST /v1/auth/refresh */
export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshDto = z.infer<typeof refreshSchema>;
