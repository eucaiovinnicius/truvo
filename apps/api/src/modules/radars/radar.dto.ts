import { z } from 'zod';
const audience = z.record(z.unknown()); const activationDestination = z.object({ connectionId: z.string().min(1), capability: z.literal('activation') });
export const createRadarSchema = z.object({ name: z.string().trim().min(1).max(120), outcomeDefinitionId: z.string().min(1), audienceAst: audience.optional(), predictionWindowDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]), optimizationGoal: z.record(z.unknown()).optional(), activationDestination: activationDestination.optional() });
export const patchRadarSchema = createRadarSchema.partial(); export const trainRadarSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200) });
export const modelLifecycleSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() });
export type CreateRadarDto = z.infer<typeof createRadarSchema>; export type PatchRadarDto = z.infer<typeof patchRadarSchema>; export type TrainRadarDto = z.infer<typeof trainRadarSchema>;
