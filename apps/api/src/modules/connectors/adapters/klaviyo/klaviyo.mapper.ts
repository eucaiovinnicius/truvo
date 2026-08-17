import { sha256 } from '../../../events/crypto.util';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import { KLAVIYO_PROVIDER } from './klaviyo.constants';
import type { NormalizedEngagementEvent, NormalizedIdentifier, NormalizedRecord, NormalizedTrait } from '../../contracts';

/**
 * Order 063 §2/§4/§7 — pure translation from Klaviyo's JSON:API profile/event
 * shapes into provider-neutral canonical records. NO identity matching happens
 * here (no lookups, no DB) — that stays `IdentityGraphService`'s job via
 * `CanonicalMappingService`. This file only EMITS namespaced identifiers/trait/
 * engagement data; it never resolves them.
 */

export interface KlaviyoProfileNode {
  id: string;
  attributes: {
    email?: string | null;
    phone_number?: string | null;
    external_id?: string | null;
    properties?: Record<string, unknown>;
    /** Only present when the request included `additional-fields[profile]=subscriptions`. */
    subscriptions?: {
      email?: { marketing?: { consent?: string | null } };
      sms?: { marketing?: { consent?: string | null } };
    };
    updated?: string;
    created?: string;
  };
}

/** Only these properties are EVER imported as traits — the workspace's own
 * explicit selection (Order 063 §2 "Do not copy arbitrary custom profile
 * properties into canonical traits"), mirroring HubSpot's `ConfiguredProperties`. */
export type ConfiguredProperties = readonly string[];

function profileIdentifiers(node: KlaviyoProfileNode): NormalizedIdentifier[] {
  const identifiers: NormalizedIdentifier[] = [
    { providerNamespace: KLAVIYO_PROVIDER, identifierType: 'external_id', identifierValue: node.id },
  ];
  const email = node.attributes.email?.trim().toLowerCase();
  if (email) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: sha256(email) });
  const phoneDigits = node.attributes.phone_number?.replace(/[^\d]/g, '');
  if (phoneDigits) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'phone_hash', identifierValue: sha256(phoneDigits) });
  return identifiers;
}

/** Full profile object (backfill/incremental Get Profiles result) → canonical
 * record. Consent surfaces AS-IS, verbatim (Order 063 §4 "never reinterpret
 * profile existence/email as consent") — Klaviyo's own strings
 * (`SUBSCRIBED`/`UNSUBSCRIBED`/`NEVER_SUBSCRIBED`/...) are stored unchanged. */
export function mapKlaviyoProfile(node: KlaviyoProfileNode, configured: ConfiguredProperties): NormalizedRecord {
  const properties = node.attributes.properties ?? {};
  const traits: NormalizedTrait[] = configured
    .filter((key) => properties[key] !== undefined && properties[key] !== null)
    .map((key) => ({ traitNamespace: 'klaviyo', traitKey: key, valueType: 'string' as const, value: String(properties[key]) }));

  const emailConsent = node.attributes.subscriptions?.email?.marketing?.consent;
  if (emailConsent != null) traits.push({ traitNamespace: 'messaging', traitKey: 'email_marketing_consent', valueType: 'string', value: emailConsent });
  const smsConsent = node.attributes.subscriptions?.sms?.marketing?.consent;
  if (smsConsent != null) traits.push({ traitNamespace: 'messaging', traitKey: 'sms_marketing_consent', valueType: 'string', value: smsConsent });

  const observedAt = node.attributes.updated ?? node.attributes.created ?? new Date().toISOString();
  return { identifiers: profileIdentifiers(node), traits, observedAt };
}

export interface KlaviyoEventNode {
  id: string;
  attributes: {
    datetime?: string;
    timestamp?: number;
    event_properties?: Record<string, unknown>;
    uuid?: string;
  };
  relationships?: {
    metric?: { data?: { id?: string } };
    profile?: { data?: { id?: string } };
  };
}

export interface KlaviyoMetricNode {
  type?: string;
  id: string;
  attributes: { name?: string };
}

/**
 * Order 063 §2 — metric-name → `NormalizedEngagementEvent.engagementKind`
 * lookup table, verified against Klaviyo's standard email-metric names.
 * Case-insensitive substring match. Anything unmatched (including Klaviyo's SMS
 * metrics and any custom/third-party metric, e.g. Truvo's own event) maps to
 * `'other'` — never guessed.
 *
 *   "Opened Email"              -> opened
 *   "Clicked Email"             -> clicked
 *   "Received Email" / "Delivered" -> delivery
 *   "Bounced Email" / "Bounced" -> bounced
 *   "Unsubscribed"              -> unsubscribed
 *   "Marked Email as Spam"      -> marked_spam
 *   (anything else)             -> other
 */
const ENGAGEMENT_KIND_RULES: ReadonlyArray<{ match: (name: string) => boolean; kind: NormalizedEngagementEvent['engagementKind'] }> = [
  { match: (n) => n.includes('opened email'), kind: 'opened' },
  { match: (n) => n.includes('clicked email'), kind: 'clicked' },
  { match: (n) => n.includes('received email') || n.includes('delivered'), kind: 'delivery' },
  { match: (n) => n.includes('bounced'), kind: 'bounced' },
  { match: (n) => n.includes('unsubscribed'), kind: 'unsubscribed' },
  { match: (n) => n.includes('marked email as spam') || n.includes('marked as spam'), kind: 'marked_spam' },
];

function engagementKindOf(metricName: string): NormalizedEngagementEvent['engagementKind'] {
  const lower = metricName.toLowerCase();
  for (const rule of ENGAGEMENT_KIND_RULES) if (rule.match(lower)) return rule.kind;
  return 'other';
}

function stringOrUndefined(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Full event object (Get Events result, requested with `include=metric` so the
 * metric name is resolved via `metricsById` without a second round trip) →
 * canonical record. `correlationId` is set ONLY when the event's OWN metric name
 * equals the workspace's configured custom Truvo metric AND the event carries
 * back the SAME `activation_id`/`correlation_id` property Truvo itself wrote via
 * `write(..., kind: 'custom_event', ...)` — the one deterministic correlation
 * case (Order 063 §7). A generic engagement event (Opened/Clicked/...) NEVER
 * gets a fabricated correlation — there is no deterministic link from it back to
 * a specific Truvo activation with current Klaviyo APIs.
 */
export function mapKlaviyoEvent(node: KlaviyoEventNode, metricsById: Map<string, KlaviyoMetricNode>, customEventMetricName: string): NormalizedRecord {
  const metricId = node.relationships?.metric?.data?.id;
  const metricName = (metricId ? metricsById.get(metricId)?.attributes.name : undefined) ?? 'unknown';
  const profileId = node.relationships?.profile?.data?.id;
  const occurredAt = node.attributes.datetime ?? (node.attributes.timestamp ? new Date(node.attributes.timestamp * 1000).toISOString() : new Date().toISOString());

  const eventProperties = node.attributes.event_properties ?? {};
  const activationId = stringOrUndefined(eventProperties.activation_id ?? eventProperties.correlation_id);
  const correlationId = metricName === customEventMetricName && activationId ? activationId : undefined;

  const engagementEvent: NormalizedEngagementEvent = {
    providerNamespace: KLAVIYO_PROVIDER,
    providerEventId: node.id,
    metricName,
    engagementKind: engagementKindOf(metricName),
    campaignId: stringOrUndefined(eventProperties.$campaign ?? eventProperties.campaign_id),
    flowId: stringOrUndefined(eventProperties.$flow ?? eventProperties.flow_id),
    correlationId,
    occurredAt,
  };

  return {
    identifiers: profileId ? [{ providerNamespace: KLAVIYO_PROVIDER, identifierType: 'external_id', identifierValue: profileId }] : [],
    engagementEvent,
    observedAt: occurredAt,
  };
}
