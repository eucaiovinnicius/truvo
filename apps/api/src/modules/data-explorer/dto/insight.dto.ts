import { z } from 'zod';

/**
 * M16 — DTOs de insights salvos (CRUD + share). O `spec` visual é validado a fundo
 * pelo InsightsService (schema do compilador); o `sql_text` passa pelo allowlist
 * sintático antes de salvar. Aqui só a forma externa do request.
 */

/**
 * Criação: `kind` discrimina o payload — visual exige `spec` (objeto), sql exige
 * `sql_text`. A validação semântica (allowlist) é feita no service.
 */
export const createInsightSchema = z.object({
  kind: z.enum(['visual', 'sql']).default('visual'),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  /** ExplorerQuerySpec (kind = visual) — validado no service. */
  spec: z.record(z.unknown()).optional(),
  /** SQL guardado (kind = sql) — validado no service (AST allowlist). */
  sql_text: z.string().max(20_000).optional(),
});
export type CreateInsightDto = {
  kind: 'visual' | 'sql';
  name: string;
  description?: string;
  spec?: unknown;
  sqlText?: string | null;
};

/** Adapta o payload cru (snake_case) para o shape que o service consome. */
export function toCreateInsightDto(raw: z.infer<typeof createInsightSchema>): CreateInsightDto {
  return {
    kind: raw.kind,
    name: raw.name,
    description: raw.description,
    spec: raw.spec,
    sqlText: raw.sql_text ?? null,
  };
}

export const updateInsightSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    spec: z.record(z.unknown()).optional(),
    sql_text: z.string().max(20_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' });
export type UpdateInsightDto = {
  name?: string;
  description?: string | null;
  spec?: unknown;
  sqlText?: string | null;
};

export function toUpdateInsightDto(raw: z.infer<typeof updateInsightSchema>): UpdateInsightDto {
  const dto: UpdateInsightDto = {};
  if (raw.name !== undefined) dto.name = raw.name;
  if (raw.description !== undefined) dto.description = raw.description;
  if (raw.spec !== undefined) dto.spec = raw.spec;
  if (raw.sql_text !== undefined) dto.sqlText = raw.sql_text;
  return dto;
}

/** POST /v1/insights/:id/share — token read-only, senha/expiração opcionais. */
export const createShareSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  expires_at: z.string().datetime().optional(),
});
export type CreateShareDto = z.infer<typeof createShareSchema>;

/** GET /v1/insights/public/:token?password=... — resolução pública read-only. */
export const publicResolveQuerySchema = z.object({
  password: z.string().max(200).optional(),
});
export type PublicResolveQueryDto = z.infer<typeof publicResolveQuerySchema>;
