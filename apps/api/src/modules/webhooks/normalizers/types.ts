/**
 * Resultado da normalização de um payload de provedor para o EventSchema.
 * O `workspace_id`, `event_id`, `source` e `received_at` são adicionados pela
 * camada de serviço (a partir da integração resolvida).
 */
export interface Normalized {
  /** Evento padrão do Truvo (purchase, refund, subscription_started, ...). */
  event_name: string;
  /** Evento cru do provedor (ex.: `orders/paid`) — para log/observabilidade. */
  provider_event: string;
  order_id?: string;
  /** ISO-8601, quando o provedor informa a data do evento. */
  timestamp?: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
}

export type ProviderPayload = Record<string, unknown>;
export type ProviderHeaders = Record<string, string | undefined>;

/** Acesso defensivo a propriedades aninhadas de payloads não tipados. */
export function pick(obj: unknown, key: string): unknown {
  if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[key];
  return undefined;
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? (n as number) : fallback;
}

export function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}
