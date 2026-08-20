# ORDER 063 — KLAVIYO CONTEXT & ACTIVATION CONNECTOR

**Priority:** P0
**Phase:** MVP
**Status:** Ready / Build Ready
**Reuse:** Build on Connector Framework + shared contract kit

## Goal

Implement Klaviyo as a real **Source + Destination** connector.

Truvo must:

`read engagement/profile context → resolve canonical customer → write Truvo profile properties / opportunity events → correlate later engagement`

Klaviyo remains the lifecycle-messaging execution layer. Truvo remains the intelligence layer.

## Preflight

Order 62 is DONE at:

`393d160`

Inspect `git status` first. Preserve named `ORDER_*.md` execution docs.

Ignore stale `ACTIVE_WORK_ITEM.md`.

Inspect:

- Order 50 Connector Framework + shared contract kit
- HubSpot bidirectional adapter/test-driver patterns
- Stripe/Shopify identity, checkpoint and rate-limit patterns
- Customer Context + Identity Graph v2
- suppression/privacy services
- existing engagement/email/campaign/event schemas
- destination idempotency/correlation ledger
- scheduler/reconciliation

No real Klaviyo connector currently exists; do not create a parallel integration framework.

## 1. API revision + authorization

Use Klaviyo's versioned server API with an explicit `revision` header.

At ticket creation, Klaviyo's current GA revision is `2026-07-15`, but before coding verify official docs and choose the latest **stable common revision supported by every endpoint used**. Never use `.pre`/beta in production scope. Pin the chosen revision in code/config and test the header.

For a third-party/tech-partner integration, prefer Klaviyo OAuth through the existing Connector Framework. Request least-privilege scopes only for enabled capabilities, equivalent to:

- `profiles:read`
- `profiles:write` only for trait writeback
- `events:read`
- `events:write` only for custom-event activation
- metric/list/segment reads only when actually configured

Do not expose private keys or add a second credential system.

## 2. Source — profiles + engagement

Backfill/incrementally read, when enabled:

- profile ID
- approved normalized identity fields
- selected profile traits
- email/SMS subscription/suppression state
- engagement events + metric identity
- relevant campaign/flow attribution available on provider events
- list/segment membership only when configured as audience context

Map profile identity only through Identity Graph v2.

Do not copy arbitrary custom profile properties into canonical traits.

Klaviyo engagement events become provider-attributed canonical engagement observations linked to the canonical customer where deterministic identity exists.

Preserve provider event ID/UUID and source timestamp.

## 3. Delayed-event-safe incremental sync

Klaviyo engagement can arrive late.

Do not implement a strict timestamp watermark that can permanently miss delayed events.

Use durable Connector Framework checkpoints with a bounded replay/overlap strategy (or equivalent provider-safe cursor design) plus provider-event-ID idempotency so:

- late events are eventually ingested;
- replay is harmless;
- checkpoint resume is deterministic;
- out-of-order engagement never rewrites newer customer state incorrectly.

Use existing scheduler/leader-lock orchestration.

## 4. Consent / eligibility context

Provider subscription state is **activation eligibility context**, not permission invented by Truvo.

Required:

- retain opted-out/suppressed state;
- never reinterpret profile existence/email as consent;
- Truvo privacy suppression remains fail-closed;
- profile trait writeback may update non-messaging metadata without implying consent;
- any Truvo custom event intended to trigger a messaging flow must pass current provider + Truvo eligibility rules before dispatch.

Prove an email-bearing but unsubscribed profile cannot be activated through the messaging path.

## 5. Destination primitive A — profile trait writeback

Support idempotent namespaced Truvo-owned properties such as:

- `truvo_radar_id`
- `truvo_radar_name`
- `truvo_score`
- `truvo_score_band`
- `truvo_expected_value`
- `truvo_recommendation`
- `truvo_scored_at`

Do not implement Radar/propensity calculation here; use explicit fixtures/payloads.

Requirements:

- never overwrite customer-owned properties unless explicitly mapped;
- internal destination idempotency/correlation ledger;
- provider result/audit recorded;
- retry/rate-limit classification;
- secret/PII-safe logs.

## 6. Destination primitive B — custom Truvo event

Support an idempotent custom event that a customer-owned Klaviyo flow can consume.

Payload must carry correlation metadata such as:

- `decision_id`
- `activation_id` / correlation ID
- Radar/opportunity identifiers
- recommendation metadata appropriate for execution

Use the Connector Framework destination ledger so replay cannot send the same logical activation twice.

Important: a successful Klaviyo Create Event response means **accepted/submitted for processing**, not confirmed marketing exposure.

Record states truthfully:

`requested → provider_accepted/submitted`

Do **not** mark `exposed`, `sent`, `opened` or `clicked` merely because the API accepted the request.

External provider result ID is optional when the provider does not return one; internal idempotency/correlation remains mandatory.

## 7. Engagement correlation

When later Klaviyo events are ingested, correlate them to prior Truvo activation/decision metadata where deterministic provider/correlation evidence exists.

At minimum distinguish:

- provider acceptance
- actual send/delivery event if available
- open
- click
- other relevant engagement

Do not fabricate attribution when correlation evidence is absent.

Do not implement the full Order 110 Decision & Action Logging model here; expose the connector-level evidence that Order 110 can consume later.

## 8. Rate limits

Use Connector Framework retry/rate-limit semantics.

Klaviyo returns `429` and currently provides `Retry-After` on rate-limit responses.

Prove:

- `Retry-After` is honored;
- rate-limited work is rescheduled, not dropped;
- checkpoints do not advance past deferred records;
- repeated retries remain idempotent.

## 9. Lists / segments

Programmatic dynamic-segment creation is **not** required.

If current stable Klaviyo APIs safely support a useful list/segment synchronization primitive, it may be implemented as an optional declared capability only.

Do not make dynamic segments a hidden dependency of activation.

## Required runtime proof

Use official/representative fixtures + deterministic provider test double and disposable Postgres 16/Redis where required.

Directly test:

- OAuth/scope failure
- pinned revision header
- profile paginated backfill + checkpoint resume
- approved trait selection only
- profile identity resolution
- engagement event/metric ingestion
- duplicate engagement event
- delayed/out-of-order event replay
- profile merge followed by later Klaviyo event
- provider opt-out/suppression state
- Truvo privacy suppression
- trait writeback idempotency
- customer-owned property collision rejection
- custom event accepted/submitted flow
- duplicate custom event prevented
- unsubscribed profile messaging activation blocked
- `429 Retry-After` handling
- missed-event reconciliation
- tenant isolation
- same Klaviyo IDs across workspaces remain isolated
- delayed engagement correlated to prior activation when evidence exists

No production Klaviyo credentials are required.

## Shared contract kit

Run the actual reusable Order 50 contract kit against the real Klaviyo adapter for every applicable **source + destination/bidirectional** capability.

Do not replace it with a provider-specific equivalent suite.

Keep fake-provider, HubSpot and Stripe shared-kit regressions green.

## Acceptance

- [ ] real Klaviyo source + destination adapter registered
- [ ] stable API revision explicitly pinned and tested
- [ ] OAuth/least-privilege credential model implemented
- [ ] profile/context backfill + incremental resume proven
- [ ] engagement event/metric ingestion proven
- [ ] delayed events cannot be permanently missed
- [ ] provider IDs/timestamps preserved
- [ ] Identity Graph v2 used; no provider-local matching
- [ ] provider subscription/suppression state retained
- [ ] messaging activation fails closed for ineligible profile
- [ ] namespaced profile writeback is idempotent
- [ ] customer-owned property collision protected
- [ ] custom Truvo event is idempotent + correlated
- [ ] provider acceptance is not falsely logged as exposure
- [ ] later engagement correlation proven where evidence exists
- [ ] `Retry-After`/rate-limit reschedule proven
- [ ] privacy suppression prevents reconstruction
- [ ] tenant isolation negative tests PASS
- [ ] actual shared Order 50 contract kit PASS for Klaviyo
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No required runtime test may be called PASS if skipped.

## Out of scope

Do not implement:

- Radar creation/scoring
- propensity / MLOps
- NBA
- campaign/flow builder
- full activation orchestration
- mandatory dynamic-segment creation
- fuzzy identity
- broad Connector Framework redesign
- general integrations UI redesign

If Klaviyo exposes a genuine framework defect, fix the smallest provider-neutral defect and add shared regression coverage.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- API revision + OAuth/scopes
- source/destination capabilities
- profile + engagement mapping
- delayed-event/checkpoint proof
- consent/suppression eligibility proof
- profile writeback evidence
- custom-event idempotency/correlation evidence
- acceptance-vs-exposure semantics
- rate-limit proof
- shared contract-kit results
- tenant/merge/privacy evidence
- migrations if any
- exact final validation results
- provider limitations/follow-ups

Do not start Order 70.

End with:

`TRUVO_CODEX_HANDOFF_END`
