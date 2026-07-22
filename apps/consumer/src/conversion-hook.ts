import type { TruvoEvent } from '@truvo/event-schema';

/**
 * Gatilho de FORWARD DE CONVERSÃO (M9) a partir do STREAM (M2) — função PURA.
 *
 * O consumer chama isto em cada conversão (purchase/lead/…) e manda o resultado ao
 * endpoint interno /v1/internal/conversions/forward, que envia server-side às
 * plataformas habilitadas do workspace. É AQUI (no consumer) que a PII viva ainda
 * existe — o forwarder normaliza/hasheia e nunca persiste IP (regra 4/5).
 *
 * Fail-closed (regra 13): sem `consent.granted` o forwarder não envia PII; sem
 * match key aproveitável nem tenta. Espelha `ConversionForwardInput` (camelCase).
 */
export const CONVERSION_FORWARD_EVENTS = [
  'purchase',
  'checkout_completed',
  'subscription_started',
  'lead',
] as const;

export interface ConversionForwardWire {
  workspaceId: string;
  eventId: string;
  eventName: string;
  timestampMs?: number;
  value?: number;
  currency?: string;
  sourceUrl?: string;
  orderId?: string;
  consent: { granted: boolean; adUserData?: boolean; adPersonalization?: boolean };
  matchKeys: {
    email?: string;
    phone?: string;
    clickId?: string;
    externalId?: string;
    userAgent?: string;
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Constrói o payload de forward a partir de um evento — ou `null` se não for uma
 * conversão encaminhável ou não houver NENHUMA match key (envio seria inútil).
 */
export function conversionForwardFromEvent(event: TruvoEvent): ConversionForwardWire | null {
  if (!(CONVERSION_FORWARD_EVENTS as readonly string[]).includes(event.event_name)) return null;

  const props = (event.properties ?? {}) as Record<string, unknown>;
  const ctx = (event.context ?? {}) as Record<string, unknown>;
  const consentRaw = (props.consent ?? {}) as Record<string, unknown>;

  const matchKeys = {
    // regra 4: e-mail/telefone já vêm hasheados nas properties; o forwarder aceita
    // hash ou claro e re-hasheia se preciso.
    email: asString(props.email_hash) ?? asString(props.email),
    phone: asString(props.phone_hash) ?? asString(props.phone),
    clickId: asString(event.click_id),
    externalId: asString(event.user_id),
    userAgent: asString(ctx.user_agent),
  };

  const hasKey =
    matchKeys.email || matchKeys.phone || matchKeys.clickId || matchKeys.externalId;
  if (!hasKey) return null;

  return {
    workspaceId: event.workspace_id,
    eventId: event.event_id,
    eventName: event.event_name,
    timestampMs: event.timestamp ? Date.parse(event.timestamp) : undefined,
    value: asNumber(props.value),
    currency: asString(props.currency),
    sourceUrl: asString(ctx.page_url),
    orderId: asString(event.order_id),
    consent: {
      granted: consentRaw.granted === true,
      adUserData: consentRaw.ad_user_data === true ? true : undefined,
      adPersonalization: consentRaw.ad_personalization === true ? true : undefined,
    },
    matchKeys,
  };
}
