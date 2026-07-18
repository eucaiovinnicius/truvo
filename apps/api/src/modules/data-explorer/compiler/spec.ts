import { z } from 'zod';
import type { ExplorerQuerySpec } from '@truvo/db';
import {
  FILTER_OPS,
  GRANULARITIES,
  MEASURE_METRICS,
  SPEC_CAPS,
} from './catalog';

/**
 * M16 — Schema zod do `ExplorerQuerySpec` (validação de FORMA + tetos estruturais).
 *
 * Esta é a 1ª barreira: rejeita specs malformados/gigantes ANTES do compilador.
 * A validação SEMÂNTICA (campo pertence ao catálogo? property tem PII? measure
 * exige property? order.by existe?) é feita no compilador (compile.ts) — que é o
 * dono do allowlist. Aqui garantimos apenas o shape e limites.
 *
 * `workspace_id`/`is_bot` NÃO existem no schema de propósito (regra 19): são
 * invariantes injetadas server-side. `include_bots` é aceito mas IGNORADO.
 */

const fieldName = z.string().trim().min(1).max(160);
const eventName = z.string().trim().min(1).max(120);

// Valor de filtro: escalar ou array de escalares (p/ in/not_in).
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const filterValue = z.union([scalar, z.array(z.union([z.string(), z.number()])).max(SPEC_CAPS.maxInValues)]);

const filterCondition = z.object({
  field: fieldName,
  op: z.enum(FILTER_OPS as unknown as [string, ...string[]]),
  value: filterValue.optional(),
});

// Árvore de filtros (recursiva) com teto de profundidade aplicado no compilador.
const filterNode: z.ZodType = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(['and', 'or']),
      conditions: z.array(filterNode).min(1).max(SPEC_CAPS.maxFilterNodes),
    }),
    filterCondition,
  ]),
);

const measure = z.object({
  id: z.string().trim().min(1).max(64),
  metric: z.enum(MEASURE_METRICS as unknown as [string, ...string[]]),
  event: eventName.optional(),
  property: fieldName.optional(),
  on: z.string().trim().min(1).max(64).optional(),
});

const funnelStep = z.object({
  event: eventName,
  filters: filterNode.optional(),
});

const dateRange = z.union([
  z.object({ preset: z.string().trim().min(1).max(40) }),
  z.object({ from: z.string().datetime(), to: z.string().datetime() }),
]);

const order = z
  .array(z.object({ by: z.string().trim().min(1).max(64), dir: z.enum(['asc', 'desc']) }))
  .max(SPEC_CAPS.maxMeasures + SPEC_CAPS.maxDimensions);

const baseFields = {
  source: z.enum(['events', 'touchpoints']).default('events'),
  dimensions: z.array(fieldName).max(SPEC_CAPS.maxDimensions).optional(),
  group_by: z.array(fieldName).max(SPEC_CAPS.maxDimensions).optional(),
  filters: filterNode.optional(),
  date_range: dateRange.optional(),
  granularity: z.enum(GRANULARITIES as unknown as [string, ...string[]]).optional(),
  order: order.optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
  include_bots: z.boolean().optional(), // aceito e IGNORADO (regra 11)
};

/**
 * União discriminada por `insight_type` — cada tipo carrega os campos que faz
 * sentido (measures p/ trends/breakdown; steps p/ funnel; etc.).
 */
export const explorerQuerySpecSchema = z.discriminatedUnion('insight_type', [
  z.object({
    insight_type: z.literal('trends'),
    ...baseFields,
    measures: z.array(measure).min(1).max(SPEC_CAPS.maxMeasures),
  }),
  z.object({
    insight_type: z.literal('breakdown'),
    ...baseFields,
    measures: z.array(measure).min(1).max(SPEC_CAPS.maxMeasures),
  }),
  z.object({
    insight_type: z.literal('funnel'),
    ...baseFields,
    steps: z.array(funnelStep).min(2).max(SPEC_CAPS.maxFunnelSteps),
    window_days: z.number().int().min(1).max(90).optional(),
  }),
  z.object({
    insight_type: z.literal('retention'),
    ...baseFields,
    retention: z.object({
      initial_event: eventName,
      return_event: eventName,
      periods: z.number().int().min(2).max(SPEC_CAPS.maxRetentionPeriods).optional(),
    }),
  }),
  z.object({
    insight_type: z.literal('path'),
    ...baseFields,
    path: z
      .object({
        max_steps: z.number().int().min(2).max(SPEC_CAPS.maxPathSteps).optional(),
        start_event: eventName.optional(),
      })
      .optional(),
  }),
]);

/** Tipo inferido do schema (compatível estruturalmente com ExplorerQuerySpec do @truvo/db). */
export type ExplorerQuerySpecInput = z.infer<typeof explorerQuerySpecSchema>;

/** Cast utilitário: o schema é um superset estrutural do type persistido. */
export function asStoredSpec(spec: ExplorerQuerySpecInput): ExplorerQuerySpec {
  return spec as unknown as ExplorerQuerySpec;
}
