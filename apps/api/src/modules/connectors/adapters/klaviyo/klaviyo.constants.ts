/**
 * Order 063 — Klaviyo API revision, endpoints, and provider identity. PINNED
 * explicitly, never resolved at runtime.
 *
 * Verified 2026-08-16 against Klaviyo's official developer documentation
 * (developers.klaviyo.com): the current stable (GA) revision is `2026-07-15`,
 * sent as a single global `revision` header on EVERY request — Klaviyo does not
 * version per-endpoint. OAuth is OAuth 2.1 with mandatory PKCE (S256). The
 * authorize redirect uses `www.klaviyo.com`; ALL token/refresh traffic must use
 * `a.klaviyo.com` — Klaviyo has blocked OAuth token endpoints on `www` since
 * March 2025.
 */
export const KLAVIYO_PROVIDER = 'klaviyo';
export const KLAVIYO_API_REVISION = '2026-07-15';
export const KLAVIYO_API_BASE_URL = 'https://a.klaviyo.com';
export const KLAVIYO_OAUTH_AUTHORIZE_URL = 'https://www.klaviyo.com/oauth/authorize';
export const KLAVIYO_OAUTH_TOKEN_URL = 'https://a.klaviyo.com/oauth/token';

/** Order 063 §2/§3 — two independently-checkpointed streams (mirrors
 * `stripe.constants.ts`'s `STRIPE_INCREMENTAL_STREAMS` / HubSpot's per-object
 * streams). Profiles are mutable state (upserted in place); events are
 * immutable append-only facts with their OWN delayed-event-safe cursor policy
 * (see `KLAVIYO_EVENT_OVERLAP_MS` below) — kept as separate streams rather than
 * one combined pull so each can advance its checkpoint independently. */
export const KLAVIYO_INCREMENTAL_STREAMS = ['profiles', 'events'] as const;
export type KlaviyoStream = (typeof KLAVIYO_INCREMENTAL_STREAMS)[number];

/** Testability knob default — production callers may override via
 * `createKlaviyoAdapter(fetchImpl, pageSize)`, same convention as
 * `HUBSPOT_DEFAULT_PAGE_SIZE`. Klaviyo's Get Events endpoint accepts up to 1000;
 * this stays conservative for a first real sync. */
export const KLAVIYO_DEFAULT_PAGE_SIZE = 100;

/**
 * Order 063 §3 — "Klaviyo engagement can arrive late... use a bounded
 * replay/overlap strategy... so late events are eventually ingested; replay is
 * harmless." On EVERY incremental tick of the `events` stream that catches up
 * (`hasMore: false`), the next checkpoint is set to `now() - overlap`, not
 * `now()` — deliberately re-requesting a trailing window of already-seen time.
 * `EngagementWriteService.upsertEvent`'s `onConflictDoNothing` (keyed by
 * `providerEventId`) makes the re-fetch a harmless no-op. 15 minutes is a
 * conservative bound for Klaviyo's own event-processing/indexing lag.
 */
export const KLAVIYO_EVENT_OVERLAP_MS = 15 * 60_000;

/** Order 063 §7 — the ONE deterministic correlation case: Truvo's own custom
 * event, read back through the normal `events` source path, carrying the SAME
 * `activation_id`/`correlation_id` property Truvo itself wrote via
 * `write(..., kind: 'custom_event', ...)`. Workspace-configurable via
 * `connection.config.custom_event_metric_name`; this is only the default. */
export const KLAVIYO_DEFAULT_CUSTOM_EVENT_METRIC_NAME = 'Truvo Activation';

/** Order 063 §1 — least-privilege OAuth scopes. `accounts:read` is mandatory on
 * every Klaviyo OAuth grant; the rest are requested only for enabled capabilities. */
export const KLAVIYO_SCOPES = {
  accountsRead: 'accounts:read',
  profilesRead: 'profiles:read',
  profilesWrite: 'profiles:write',
  eventsRead: 'events:read',
  eventsWrite: 'events:write',
} as const;

/** Order 063 §5 — namespaced, Truvo-owned writeback properties, verbatim from
 * the order. Never a customer-owned property, never anything outside this
 * fixed, reviewable list (same "fixed list, no heuristic" convention as
 * `HUBSPOT_WRITEBACK_PROPERTIES`). */
export const KLAVIYO_WRITEBACK_PROPERTIES = [
  'truvo_radar_id',
  'truvo_radar_name',
  'truvo_score',
  'truvo_score_band',
  'truvo_expected_value',
  'truvo_recommendation',
  'truvo_scored_at',
] as const;
export type KlaviyoWritebackProperty = (typeof KLAVIYO_WRITEBACK_PROPERTIES)[number];
