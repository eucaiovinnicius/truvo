import type { TruvoEvent } from '@truvo/event-schema';

/**
 * Gatilho de PROJEÇÃO CANÔNICA (Order 040) a partir do STREAM (M2) — função PURA,
 * espelhando `identity/event-hook.ts` e `conversion-hook.ts`. O consumer chama isto
 * depois de um `forwardIdentity` bem-sucedido (que já tem o `canonical_id`) e manda
 * o resultado para `/v1/internal/context/project`, que decide (via
 * `outcome-projection.registry.ts`, na API) se o `event_name` tem uma regra
 * conhecida — eventos sem regra viram um no-op explícito lá, nunca aqui.
 */
export interface ProjectionForwardWire {
  workspace_id: string;
  canonical_id: string;
  event: {
    event_id: string;
    event_name: string;
    order_id?: string;
    timestamp?: string;
    properties: Record<string, unknown>;
  };
}

/** Monta o payload de projeção — `null` sem um `canonical_id` resolvido (nada a anexar). */
export function buildProjectionRequest(event: TruvoEvent, canonicalId: string | undefined): ProjectionForwardWire | null {
  if (!canonicalId) return null;
  return {
    workspace_id: event.workspace_id,
    canonical_id: canonicalId,
    event: {
      event_id: event.event_id,
      event_name: event.event_name,
      order_id: event.order_id,
      timestamp: event.timestamp,
      properties: event.properties ?? {},
    },
  };
}
