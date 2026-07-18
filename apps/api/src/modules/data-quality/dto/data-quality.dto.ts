import { z } from 'zod';

/**
 * Aceita `YYYY-MM-DD` OU um ISO-8601 datetime. A normalização para dia UTC é
 * feita no serviço (util.toDayUtc). Mantido como string p/ não acoplar o schema
 * ao fuso.
 */
const dateInput = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    'data inválida — use YYYY-MM-DD ou ISO-8601',
  )
  .optional();

/** GET /v1/data-quality/reconciliation?start=&end= */
export const reconciliationQuerySchema = z.object({
  start: dateInput,
  end: dateInput,
});
export type ReconciliationQueryDto = z.infer<typeof reconciliationQuerySchema>;

/** POST /v1/data-quality/reconciliation/run — recomputa e persiste um intervalo. */
export const reconciliationRunSchema = z.object({
  start: dateInput,
  end: dateInput,
});
export type ReconciliationRunDto = z.infer<typeof reconciliationRunSchema>;

/** GET /v1/data-quality/bot-report?start=&end= */
export const botReportQuerySchema = z.object({
  start: dateInput,
  end: dateInput,
});
export type BotReportQueryDto = z.infer<typeof botReportQuerySchema>;

/** GET /v1/data-quality/discrepancy?ad_account=&start=&end= */
export const discrepancyQuerySchema = z.object({
  ad_account: z.string().trim().min(1).max(200).optional(),
  start: dateInput,
  end: dateInput,
});
export type DiscrepancyQueryDto = z.infer<typeof discrepancyQuerySchema>;
