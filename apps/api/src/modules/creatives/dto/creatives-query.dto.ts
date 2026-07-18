import { z } from 'zod';
import {
  CREATIVE_ORDER_BY,
  CREATIVE_PHASES,
  CREATIVE_PLATFORMS,
  CREATIVE_TYPES,
  toDayUtc,
} from '../creatives.constants';

/**
 * DTOs de LEITURA/AÇÃO do M10 (GET /v1/creatives/*, POST sync/accounts). Zod valida
 * query/body. Enums são allowlists fechadas (plataforma/tipo/fase/order_by) — nunca
 * viram texto cru no SQL (passam por query_params; ver creatives-ch.ts).
 */

const platformEnum = z.enum(CREATIVE_PLATFORMS as unknown as [string, ...string[]]);
const typeEnum = z.enum(CREATIVE_TYPES as unknown as [string, ...string[]]);
const phaseEnum = z.enum(CREATIVE_PHASES as unknown as [string, ...string[]]);
const orderByEnum = z.enum(CREATIVE_ORDER_BY as unknown as [string, ...string[]]);

/** Data `YYYY-MM-DD` ou ISO datetime — normalizada depois por resolveDayRange. */
const dayString = z
  .string()
  .trim()
  .refine((v) => toDayUtc(v) !== null, { message: 'data inválida (use YYYY-MM-DD ou ISO)' });

const rangeShape = {
  start: dayString.optional(),
  end: dayString.optional(),
};

/** GET /v1/creatives (grid/tabela). */
export const gridQuerySchema = z.object({
  platform: platformEnum.optional(),
  campaign_id: z.string().trim().min(1).max(128).optional(),
  type: typeEnum.optional(),
  phase: phaseEnum.optional(),
  order_by: orderByEnum.optional(),
  order_dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  ...rangeShape,
});
export type GridQueryDto = z.infer<typeof gridQuerySchema>;

/** GET /v1/creatives/:adId (sheet de detalhe). */
export const detailQuerySchema = z.object({
  platform: platformEnum.optional(),
  buyers_limit: z.coerce.number().int().min(0).max(100).default(25),
  ...rangeShape,
});
export type DetailQueryDto = z.infer<typeof detailQuerySchema>;

/** GET /v1/creatives/compare?ad_ids=id1,id2,id3 (2–4 criativos). */
export const compareQuerySchema = z.object({
  ad_ids: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(z.string().min(1).max(128)).min(2, 'informe 2 a 4 criativos').max(4),
  ),
  platform: platformEnum.optional(),
  ...rangeShape,
});
export type CompareQueryDto = z.infer<typeof compareQuerySchema>;

/** GET /v1/creatives/:adId/scorecard. */
export const scorecardQuerySchema = z.object({
  platform: platformEnum.optional(),
  ...rangeShape,
});
export type ScorecardQueryDto = z.infer<typeof scorecardQuerySchema>;

/** GET /v1/creatives/alerts. */
export const alertsQuerySchema = z.object({
  platform: platformEnum.optional(),
  persist: z
    .preprocess((v) => (v === 'false' || v === '0' ? false : v === 'true' || v === '1' ? true : v), z.boolean())
    .optional(),
  ...rangeShape,
});
export type AlertsQueryDto = z.infer<typeof alertsQuerySchema>;

/** POST /v1/creatives/sync — dispara o sync das Ads APIs do workspace. */
export const syncBodySchema = z.object({
  platform: platformEnum.optional(),
  ...rangeShape,
});
export type SyncBodyDto = z.infer<typeof syncBodySchema>;

/** POST /v1/creatives/accounts — conecta uma conta de anúncio ao workspace. */
export const accountBodySchema = z.object({
  platform: platformEnum,
  external_account_id: z.string().trim().min(1).max(128),
  name: z.string().trim().max(200).optional(),
  config: z.record(z.unknown()).optional(),
});
export type AccountBodyDto = z.infer<typeof accountBodySchema>;
