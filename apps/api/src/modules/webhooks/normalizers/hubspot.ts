import { hashEmail } from '../crypto/hash';
import { num, pick, str, type Normalized, type ProviderHeaders, type ProviderPayload } from './types';

/**
 * HubSpot (PRD §7 M4 — CRM & Marketing):
 *   contact.creation        → lead
 *   contact.propertyChange  → identify
 *   deal.creation           → checkout_started
 *   deal.propertyChange     → purchase (quando dealstage = closedwon/paid)
 *   email.open / email.click / form.submission → email_open / email_click / form_submit
 *
 * HubSpot pode enviar de duas formas:
 *  1. Webhooks de CRM (app) — um ARRAY de eventos assinados (X-HubSpot-Signature-V3).
 *  2. Webhook de Workflow — um corpo custom (usado p/ eventos de e-mail marketing).
 *
 * // TODO(live): HubSpot envia LOTES (array). Aqui processamos o PRIMEIRO evento do
 * // lote (o pipeline de webhooks é single-event). Para lotes, iterar no service.
 */

const SUBSCRIPTION_MAP: Record<string, string> = {
  'contact.creation': 'lead',
  'contact.propertychange': 'identify',
  'deal.creation': 'checkout_started',
  'deal.propertychange': 'custom', // refinado p/ purchase abaixo
};

const EMAIL_EVENT_MAP: Record<string, string> = {
  'email.open': 'email_open',
  'email.opened': 'email_open',
  email_open: 'email_open',
  open: 'email_open',
  'email.click': 'email_click',
  'email.clicked': 'email_click',
  email_click: 'email_click',
  click: 'email_click',
  'email.delivered': 'email_delivered',
  'email.sent': 'email_sent',
  'email.bounce': 'email_bounce',
  'form.submission': 'form_submit',
  form_submission: 'form_submit',
  form_submit: 'form_submit',
};

/** HubSpot manda um ARRAY de eventos — pega o primeiro do lote. */
function firstEvent(payload: ProviderPayload): Record<string, unknown> {
  if (Array.isArray(payload)) return (payload[0] as Record<string, unknown>) ?? {};
  const events = pick(payload, 'events');
  if (Array.isArray(events)) return (events[0] as Record<string, unknown>) ?? {};
  return payload;
}

function rawEventType(ev: Record<string, unknown>): string {
  return (
    str(pick(ev, 'subscriptionType')) ??
    str(pick(ev, 'eventType')) ??
    str(pick(ev, 'event')) ??
    'unknown'
  ).toLowerCase();
}

export function hubspotEventType(payload: ProviderPayload): string {
  return rawEventType(firstEvent(payload));
}

export function normalizeHubspot(
  payload: ProviderPayload,
  _headers: ProviderHeaders,
): Normalized | null {
  const ev = firstEvent(payload);
  const rawType = rawEventType(ev);
  const mapped = SUBSCRIPTION_MAP[rawType] ?? EMAIL_EVENT_MAP[rawType];
  if (!mapped) return null;

  const propName = str(pick(ev, 'propertyName'))?.toLowerCase();
  const propVal = str(pick(ev, 'propertyValue'))?.toLowerCase();

  // deal.propertyChange com dealstage fechado/pago → purchase.
  let eventName = mapped;
  if (rawType === 'deal.propertychange' && propName === 'dealstage' && propVal) {
    eventName = /won|paid|closedwon|closed_won/.test(propVal) ? 'purchase' : 'custom';
  }

  const email = str(pick(ev, 'email') ?? pick(ev, 'contactEmail'));
  const occurredAt = pick(ev, 'occurredAt') ?? pick(ev, 'timestamp');
  const timestamp =
    typeof occurredAt === 'number'
      ? new Date(occurredAt).toISOString()
      : (str(occurredAt) ?? undefined);

  return {
    event_name: eventName,
    provider_event: rawType,
    order_id: str(pick(ev, 'objectId') ?? pick(ev, 'dealId') ?? pick(ev, 'orderId')),
    timestamp,
    properties: {
      value: num(pick(ev, 'amount') ?? pick(ev, 'value')),
      currency: str(pick(ev, 'currency')) ?? 'BRL',
      email_hash: email ? hashEmail(email) : undefined,
      hubspot_object_id: str(pick(ev, 'objectId')),
      hubspot_portal_id: str(pick(ev, 'portalId')),
      property_name: propName,
      property_value: propVal,
      campaign: str(pick(ev, 'campaign') ?? pick(ev, 'emailCampaignId')),
    },
    context: {
      utm_source: str(pick(ev, 'utm_source')) ?? 'hubspot',
      utm_medium: str(pick(ev, 'utm_medium')) ?? 'crm',
      utm_campaign: str(pick(ev, 'utm_campaign') ?? pick(ev, 'campaign')),
    },
  };
}
