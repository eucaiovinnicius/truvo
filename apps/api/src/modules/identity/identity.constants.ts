/**
 * Contrato compartilhado da fila de STITCHING RETROATIVO do M8.
 *
 * Producer: a API (POST /v1/identity/identify e o hook de purchase do consumer M2)
 * enfileira um job quando um merge acontece. Consumer: o worker dedicado em
 * `apps/consumer/src/identity/` recalcula (touchpoints, funis, atribuição).
 *
 * Usamos um Redis STREAM (não uma list) para ter consumer group + checkpoints
 * (XACK) — o stitching retroativo precisa ser idempotente e reprocessável (PRD §15).
 * Estes MESMOS nomes/shape estão duplicados em
 * `apps/consumer/src/identity/stitch-queue.ts` (api e consumer não compartilham
 * código fora dos packages) — manter em sincronia. Ver notes.
 */
export const IDENTITY_STITCH_STREAM = process.env.IDENTITY_STITCH_STREAM ?? 'identity.stitch';
export const IDENTITY_STITCH_GROUP = process.env.IDENTITY_STITCH_GROUP ?? 'identity-stitch-workers';

/** Payload do job de stitching retroativo (campos são strings no stream do Redis). */
export interface StitchJob {
  /** Tenant (regra 1). */
  workspace_id: string;
  /** Canonical vencedor após o merge. */
  canonical_id: string;
  /** Canonicals perdedores que precisam ser reescritos → canonical_id. */
  merged_from: string[];
  /** Motivo (auditoria). */
  reason: string;
  /** ISO 8601 de quando o merge foi registrado. */
  enqueued_at: string;
}
