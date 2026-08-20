# ORDER 050 — CONNECTOR FRAMEWORK

**Priority:** P0  
**Phase:** Foundation  
**Status:** Ready / Build Ready  
**Reuse:** Refactor existing inbound integrations + `integrations-out`

## Goal

Create one provider-agnostic framework for **Source**, **Destination** and **Bidirectional** integrations so Orders 60–63 can be implemented by adding adapters/mappings, not changing framework internals.

Do not build Shopify/HubSpot/Stripe/Klaviyo adapters in this Order.

## Preflight

Order 45 is DONE at:

`48db4298677b171c4e4c9ea84a2de2931ff3d80f`

Inspect `git status` first. Preserve user execution docs.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Inspect first

- existing inbound `webhooks` / `integrations`
- existing `integrations-out`
- credential encryption/storage
- webhook verification/normalization
- current retry/error patterns
- scheduler/background-job patterns
- Order 30 Customer Context services
- Order 45 `IdentityGraphService`
- Order 35 audit/redaction/security primitives
- observability metrics/logging
- existing `/v1/integrations` routes
- Postgres migration framework

Reuse these; do not create a parallel integration stack.

## Core contracts

Provide typed provider-neutral abstractions equivalent to:

- `ConnectorDefinition`
- `ConnectorConnection`
- `SourceAdapter`
- `DestinationAdapter`
- `ConnectionTest`
- `SyncCheckpoint`

A definition declares provider metadata + capabilities.

A connection is workspace-scoped installation/configuration state.

Support capabilities independently:

- source-only
- destination-only
- bidirectional
- webhook ingest
- initial backfill
- incremental pull
- outbound profile/audience/event/score/action where supported

Provider code must contain **no Radar/ML business logic**.

## Connection lifecycle

Model lifecycle equivalent to:

`draft → authorizing → connected → syncing → healthy/degraded/error → disconnected`

Keep **credential validity**, **connection health** and **sync state** separate.

A failed sync must not automatically invalidate otherwise-valid credentials.

Preserve existing endpoints during migration; adapt `/v1/integrations` where compatible instead of introducing competing concepts.

## Credentials

Use existing secure secret/encryption abstractions.

Requirements:

- OAuth-style refreshable tokens and API-key providers fit the same connection interface
- stored secret material never returns from API after persistence
- refresh/update is auditable
- logs/errors use existing redaction
- workspace isolation is mandatory

Do not add a new secret vendor.

## Sync orchestration

Implement durable, workspace/provider-scoped orchestration:

- async initial backfill
- incremental sync from durable cursor/high-water mark
- idempotent jobs
- retry transient failures with exponential backoff + jitter
- permanent auth/mapping failures become visible errors
- no infinite retry
- provider rate limits pause/reschedule; never silently drop records
- checkpoint advances only after successful processing boundary

Use existing scheduler/queue infrastructure where practical.

## Canonical mapping

Adapters map provider objects into existing canonical services:

- Customer Context
- Identity Graph v2
- Event/context projection where appropriate

Do not let adapters write their own identity matching rules.

No provider-specific fields may leak into provider-neutral public contracts without namespacing.

## Webhooks

Framework must expose provider-specific verification **before** normalization.

Verified deliveries become durable/idempotent jobs, then canonical events/context.

Duplicate delivery must be harmless.

Invalid signatures fail closed and are observable.

Preserve current webhook endpoints/semantics through adapters where possible.

## Destination writes

Provide provider-neutral outbound execution contract.

Each write must support where applicable:

- idempotency key
- correlation ID
- external result ID
- retry classification
- activation/exposure audit event

Do not build NBA or campaign orchestration here.

## Observability

Expose provider/workspace signals for:

- last successful sync
- sync lag
- records read/written
- mapping failures
- retries
- rate-limit waits
- auth failures
- webhook verification failures

Use existing observability package; no new monitoring stack.

## Contract test kit

Build a reusable adapter contract suite plus a **fake provider adapter** proving framework behavior.

Runtime-test at least:

- source-only capability
- destination-only capability
- bidirectional capability
- connection lifecycle
- credential test/failure separation from sync health
- initial backfill + checkpoint resume
- transient retry/backoff
- permanent error stop
- rate-limit reschedule
- duplicate webhook idempotency
- invalid webhook signature rejection
- outbound idempotency/result correlation
- tenant isolation

Use disposable Postgres/Redis or existing local infrastructure where required. No staging/production data.

## Acceptance

- [ ] shared connector contracts exist
- [ ] existing inbound/outbound modules are adapted/reused, not duplicated
- [ ] source/destination/bidirectional roles proven
- [ ] encrypted credential lifecycle proven with no secret leakage
- [ ] health and sync state are separate
- [ ] durable checkpoint/backfill resume proven
- [ ] retry/backoff/rate-limit behavior proven
- [ ] webhook verify → durable job → canonical path proven
- [ ] duplicate webhook harmless
- [ ] destination idempotency/correlation/audit proven
- [ ] provider/workspace observability emitted
- [ ] tenant isolation negative tests PASS
- [ ] fake adapter passes reusable contract suite
- [ ] existing integration endpoints remain compatible
- [ ] Identity Graph / Customer Context are used rather than provider-local matching
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No relevant runtime test may be called PASS if skipped.

## Out of scope

Do not implement:

- Shopify / HubSpot / Stripe / Klaviyo provider adapters
- Radars / propensity / NBA
- full activation product flows
- new auth/secret/observability vendor
- broad UI redesign
- provider-specific identity heuristics

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include framework contracts, existing code reused, connection lifecycle, credential evidence, checkpoint/retry/rate-limit proofs, webhook signature/idempotency evidence, destination proof, tenant isolation, observability, migrations and exact final validation results.

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
