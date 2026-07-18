import {
  EVENT_SOURCES,
  SOURCE_PRIORITY,
  type EventSource,
  type TruvoEvent,
} from '@truvo/event-schema';

/**
 * Gatilho de stitching a partir do STREAM DE EVENTOS (M2) — funções PURAS.
 *
 * O trigger do stitching (PRD §7 M8) é o evento `identify` ou `purchase` com email.
 * Estas helpers extraem, de um TruvoEvent já normalizado, o payload de identify que
 * o motor do M8 consome. Ficam separadas (puras, sem I/O) para o consumer do M2
 * poder chamá-las na integração sem acoplar o grafo de identidade ao pipeline.
 *
 * COORDENAÇÃO COM O DEDUP DO M2 (regra 2/10): o consumer do M2 já descarta a
 * conversão de fonte menos confiável ANTES de persistir (resolveOrderId +
 * SOURCE_PRIORITY). Logo, o evento que dispara o identify JÁ carrega a fonte
 * VENCEDORA do `order_id` — aqui só a propagamos (`source`) para o touchpoint.
 * `orderSourceRank` é exposto p/ quem precisar reordenar/depurar empates.
 *
 * // TODO(live) (wiring de integração — decidido na onda M2×M8):
 *   No handler do consumer do M2, após bot/enrich e ANTES/DEPOIS do insert:
 *     const req = identifyRequestFromEvent(event);
 *     if (req) await forwardToIdentity(req);   // HTTP POST p/ /v1/identity/identify
 *                                              // (auth interno) OU enqueue p/ um
 *                                              // drainer no processo da API.
 *   A escrita no grafo (Postgres identity_links/merges) vive no IdentityService da
 *   API — que tem Drizzle; o consumer NÃO escreve Postgres (deps ausentes de propósito).
 */

/** Eventos que disparam stitching. */
export const IDENTITY_TRIGGER_EVENTS = ['identify', 'purchase'] as const;

/** Payload de identify derivado de um evento (espelha o POST /v1/identity/identify). */
export interface IdentifyRequest {
  workspace_id: string;
  anonymous_id?: string;
  user_id?: string;
  email_hash?: string;
  phone_hash?: string;
  click_id?: string;
  order_id?: string;
  source?: EventSource;
  context?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
  };
}

/** Rank de prioridade da fonte p/ dedup de order_id (menor = mais confiável). */
export function orderSourceRank(source: string): number {
  const rank = SOURCE_PRIORITY[source as EventSource];
  return rank ?? EVENT_SOURCES.length; // fonte desconhecida = menos confiável
}

/** É um evento relevante p/ o grafo de identidade? */
export function isIdentityTrigger(event: TruvoEvent): boolean {
  const isTriggerName = (IDENTITY_TRIGGER_EVENTS as readonly string[]).includes(event.event_name);
  return isTriggerName || Boolean(event.user_id) || Boolean(event.order_id);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Constrói o IdentifyRequest a partir de um evento — ou `null` se não há trigger
 * nem identificador aproveitável. `email_hash`/`phone_hash` vêm JÁ hasheados nas
 * properties (regra 4: o e-mail/telefone em claro nunca chega até aqui).
 */
export function identifyRequestFromEvent(event: TruvoEvent): IdentifyRequest | null {
  if (!isIdentityTrigger(event)) return null;

  const props = event.properties ?? {};
  const ctx = event.context ?? {};

  const req: IdentifyRequest = {
    workspace_id: event.workspace_id,
    anonymous_id: asString(event.anonymous_id),
    user_id: asString(event.user_id),
    email_hash: asString(props.email_hash),
    phone_hash: asString(props.phone_hash),
    click_id: asString(event.click_id),
    order_id: asString(event.order_id),
    source: event.source,
    context: {
      utm_source: asString(ctx.utm_source),
      utm_medium: asString(ctx.utm_medium),
      utm_campaign: asString(ctx.utm_campaign),
    },
  };

  const hasIdentifier =
    req.anonymous_id ||
    req.user_id ||
    req.email_hash ||
    req.phone_hash ||
    req.click_id ||
    req.order_id;
  if (!hasIdentifier) return null;

  return req;
}
