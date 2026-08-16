/**
 * Order 061 §1 — HubSpot CRM API version, PINNED explicitly. Never resolved at
 * runtime, never auto-upgraded.
 *
 * Verified 2026-08-16 against HubSpot's official developer documentation:
 * HubSpot moved to DATE-BASED API versioning (`developers.hubspot.com/blog/a-
 * developers-guide-to-hubspots-date-based-api-versioning` /
 * `developers.hubspot.com/changelog/introducing-date-based-api-versioning`) —
 * requests are versioned by URL segment (`/crm/objects/{version}/contacts`), each
 * version shipped ~March/September and supported at least 18 months. The current
 * stable version as of this date is `2026-03`. Bumping this constant is a
 * deliberate, reviewed change — not something this adapter does on its own.
 */
export const HUBSPOT_API_VERSION = '2026-03';

export const HUBSPOT_PROVIDER = 'hubspot';

export const HUBSPOT_API_BASE_URL = 'https://api.hubapi.com';
export const HUBSPOT_OAUTH_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
export const HUBSPOT_OAUTH_TOKEN_URL = `${HUBSPOT_API_BASE_URL}/oauth/v1/token`;

/**
 * Least-privilege, per-object scopes (verified against HubSpot's current
 * `developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/
 * scopes` reference) — requested ONLY for objects the workspace actually enabled
 * (Order 061 §1: "scopes requested only for configured objects/features").
 * Contacts read is the floor; everything else is additive per configuration.
 */
export const HUBSPOT_SCOPES = {
  contactsRead: 'crm.objects.contacts.read',
  contactsWrite: 'crm.objects.contacts.write',
  companiesRead: 'crm.objects.companies.read',
  companiesWrite: 'crm.objects.companies.write',
  dealsRead: 'crm.objects.deals.read',
  dealsWrite: 'crm.objects.deals.write',
} as const;

/** subscriptionType values this adapter's webhook dispatcher understands —
 * verified against HubSpot's current Webhooks (CRM Events) guide. Association
 * change events are intentionally excluded from v1 of this adapter's webhook path
 * (Order 061 §6 scope: property/creation/deletion changes; association CHANGES
 * are still picked up via reconciliation's periodic re-read of each object's own
 * associations — see `hubspot.adapter.ts#incrementalPull`). */
export const HUBSPOT_WEBHOOK_SUBSCRIPTION_TYPES = [
  'contact.creation', 'contact.propertyChange', 'contact.deletion', 'contact.restore', 'contact.merge',
  'company.creation', 'company.propertyChange', 'company.deletion', 'company.restore', 'company.merge',
  'deal.creation', 'deal.propertyChange', 'deal.deletion', 'deal.restore', 'deal.merge',
] as const;
export type HubspotWebhookSubscriptionType = (typeof HUBSPOT_WEBHOOK_SUBSCRIPTION_TYPES)[number];

export const HUBSPOT_DEFAULT_PAGE_SIZE = 100;

/** Namespaced, Truvo-owned writeback properties (Order 061 §8) — the ONLY
 * properties this adapter's `DestinationAdapter.write()` is allowed to set. Never
 * a customer-owned property, and never anything outside this fixed, reviewable
 * list (same "fixed list, no heuristic" convention as `outcome-projection.registry.ts`). */
export const HUBSPOT_WRITEBACK_PROPERTIES = [
  'truvo_propensity_band',
  'truvo_propensity_score',
  'truvo_radar_name',
  'truvo_radar_id',
  'truvo_opportunity_value',
  'truvo_last_scored_at',
] as const;
export type HubspotWritebackProperty = (typeof HUBSPOT_WRITEBACK_PROPERTIES)[number];
