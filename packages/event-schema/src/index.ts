import { z } from 'zod';

/**
 * EventSchema do Truvo — fonte única de verdade do formato de evento (PRD §4).
 * Compartilhado por api (ingestão), consumer (processamento) e web.
 */

/** Eventos padrão do sistema (PRD §4). */
export const STANDARD_EVENTS = [
  'page_view',
  'session_start',
  'button_click',
  'form_submit',
  'lead',
  'checkout_started',
  'checkout_completed',
  'purchase',
  'refund',
  'subscription_started',
  'subscription_cancelled',
  'identify',
  'custom',
] as const;
export type StandardEvent = (typeof STANDARD_EVENTS)[number];

/** Fontes de evento, da mais confiável para a menos (PRD §4). */
export const EVENT_SOURCES = ['webhook', 'api', 'gateway', 'redirect', 'pixel', 'url'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/**
 * Prioridade de dedup por `order_id`: índice menor vence (webhook > ... > url).
 * Regra de negócio 2 / 10 do PRD.
 */
export const SOURCE_PRIORITY = Object.fromEntries(
  EVENT_SOURCES.map((s, i) => [s, i]),
) as Record<EventSource, number>;

export const deviceTypeSchema = z.enum(['mobile', 'desktop', 'tablet']);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const eventContextSchema = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
    page_url: z.string().optional(),
    referrer: z.string().optional(),
    user_agent: z.string().optional(),
    ip: z.string().optional(), // descartado após enrich — nunca persistido (regra 5)
    ip_country: z.string().optional(),
    ip_city: z.string().optional(),
    device_type: deviceTypeSchema.optional(),
    os: z.string().optional(),
    browser: z.string().optional(),
  })
  .passthrough();
export type EventContext = z.infer<typeof eventContextSchema>;

/** Evento já normalizado (pós-ingestão). */
export const eventSchema = z.object({
  event_id: z.string(),
  event_name: z.string(),
  source: z.enum(EVENT_SOURCES),
  timestamp: z.string().datetime().optional(),
  received_at: z.string().datetime().optional(),
  workspace_id: z.string(),
  anonymous_id: z.string().optional(),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  click_id: z.string().optional(),
  order_id: z.string().optional(),
  properties: z.record(z.unknown()).default({}),
  context: eventContextSchema.default({}),
});
export type TruvoEvent = z.infer<typeof eventSchema>;

/**
 * Payload de ingestão (`POST /v1/events`): event_id/received_at/timestamp
 * podem ser gerados no servidor se ausentes.
 */
export const ingestEventSchema = eventSchema.partial({
  event_id: true,
  received_at: true,
  timestamp: true,
});
export type IngestEvent = z.infer<typeof ingestEventSchema>;
