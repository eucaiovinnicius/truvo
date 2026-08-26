import { z } from 'zod';
const audience = z.object({ version: z.literal(1), op: z.literal('identified') });
export const createRadarSchema = z.object({ name: z.string().trim().min(1).max(120), outcomeDefinitionId: z.string().min(1), audienceAst: audience.optional(), predictionWindowDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]), optimizationGoal: z.record(z.unknown()).optional() });
export const patchRadarSchema = createRadarSchema.partial(); export const trainRadarSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200) });
export type CreateRadarDto = z.infer<typeof createRadarSchema>; export type PatchRadarDto = z.infer<typeof patchRadarSchema>; export type TrainRadarDto = z.infer<typeof trainRadarSchema>;
