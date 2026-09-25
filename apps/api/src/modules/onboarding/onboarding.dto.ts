import { z } from 'zod';
import { createRadarSchema } from '../radars/radar.dto';

export const startOnboardingSchema = z.object({ workspaceName: z.string().trim().min(1).max(120).optional() });
export const selectPathSchema = z.object({ path: z.enum(['ecommerce', 'saas', 'custom']) });
export const linkConnectionSchema = z.object({ connectionId: z.string().trim().min(1).max(200) });
export const onboardingReadinessSchema = z.object({ outcomeNamespace: z.string().trim().max(120).optional(), outcomeKey: z.string().trim().max(120).optional(), historicalWindowDays: z.number().int().min(0).max(3650).optional() });
export const createFirstRadarSchema = createRadarSchema.extend({ idempotencyKey: z.string().trim().min(8).max(200) });

export type SelectPathDto = z.infer<typeof selectPathSchema>;
export type CreateFirstRadarDto = z.infer<typeof createFirstRadarSchema>;
