import { z } from 'zod';
import { PLAN_IDS } from '@truvo/db';

/**
 * DTOs do M11. Zod valida body de `POST /v1/billing/checkout`. O plano é uma
 * allowlist fechada (PLAN_IDS) — nunca vira texto livre. A regra de negócio
 * (Enterprise não tem Checkout self-service; downgrade via Portal) é aplicada no
 * BillingService.
 */
export const createCheckoutSchema = z.object({
  plan: z.enum(PLAN_IDS as unknown as [string, ...string[]]),
  /** Sobrescreve a URL de sucesso (opcional; default vem do env). */
  successUrl: z.string().url().optional(),
  /** Sobrescreve a URL de cancelamento (opcional; default vem do env). */
  cancelUrl: z.string().url().optional(),
});
export type CreateCheckoutDto = z.infer<typeof createCheckoutSchema>;
