import { z } from 'zod';
import { AI_GOALS, AI_WINDOWS, type AiGoal } from '../ai.constants';

/**
 * DTOs (zod) do M17. Validados por ZodValidationPipe (mesmo padrão do M7/M16).
 * O vocabulário fechado (goals/janelas) é allowlist — nada do cliente vira query
 * fora dele. `segment` é SEM PII de propósito (só rótulos de canal/UTM).
 */

const goalEnum = z.enum(AI_GOALS as unknown as [AiGoal, ...AiGoal[]]);

const windowDays = z
  .number()
  .int()
  .refine((v) => (AI_WINDOWS as readonly number[]).includes(v), {
    message: `window_days deve ser um de: ${AI_WINDOWS.join(', ')}`,
  });

const segmentSchema = z
  .object({
    channel: z.string().trim().min(1).max(60).optional(),
    utm_source: z.string().trim().min(1).max(120).optional(),
    utm_medium: z.string().trim().min(1).max(120).optional(),
    utm_campaign: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

// ─────────────────────────── objetivos ───────────────────────────

export const createObjectiveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: goalEnum,
  window_days: windowDays.optional(),
  segment: segmentSchema.optional(),
});
export type CreateObjectiveDto = z.infer<typeof createObjectiveSchema>;

// ─────────────────────────── analyze (run assíncrono) ───────────────────────────

export const analyzeSchema = z
  .object({
    objective_id: z.string().trim().min(1).max(64).optional(),
    goal: goalEnum.optional(),
    window_days: windowDays.optional(),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    segment: segmentSchema.optional(),
  })
  .refine((v) => Boolean(v.objective_id) || Boolean(v.goal), {
    message: 'Informe objective_id ou goal.',
  });
export type AnalyzeDto = z.infer<typeof analyzeSchema>;

// ─────────────────────────── best journeys (GET query) ───────────────────────────

export const bestQuerySchema = z.object({
  goal: goalEnum,
  window_days: z.coerce.number().int().optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  segment_channel: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type BestQueryDto = z.infer<typeof bestQuerySchema>;

// ─────────────────────────── ask (Q&A) ───────────────────────────

export const askSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  conversation_id: z.string().trim().min(1).max(64).optional(),
});
export type AskDto = z.infer<typeof askSchema>;

// ─────────────────────────── recommendations (GET query) ───────────────────────────

export const recommendationsQuerySchema = z.object({
  run_id: z.string().trim().min(1).max(64).optional(),
});
export type RecommendationsQueryDto = z.infer<typeof recommendationsQuerySchema>;
