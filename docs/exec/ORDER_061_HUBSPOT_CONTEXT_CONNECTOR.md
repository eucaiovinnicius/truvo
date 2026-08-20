# ORDER 061 — HUBSPOT CONTEXT CONNECTOR

**Priority:** P0
**Phase:** MVP
**Status:** Ready / Build Ready
**Reuse:** Adapt existing HubSpot inbound + outbound code on Connector Framework

## Goal

Implement HubSpot as a real **bidirectional CRM context connector**.

A workspace must be able to:

`connect HubSpot → select CRM objects/properties → historical backfill → verified incremental sync/reconciliation → canonical Customer/Account/Deal context → optional Truvo writeback`

HubSpot supplies context. It must not become the source of Truvo Radar/business logic.

## Preflight

Order 40 closure is DONE at:

`cabf87c`

Order 60 Shopify is DONE at:

`b2c6645`

Inspect `git status` first and preserve user execution docs.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Inspect first

- Order 50 Connector Framework + contract kit
- Order 60 first real adapter patterns
- existing HubSpot webhook normalizer
- existing HubSpot outbound behavioral-event code
- connector HTTP surface + credential storage
- Customer Context + Identity Graph v2
- canonical relationships/outcomes
- Order 55 suppression/erasure boundaries
- scheduler/reconciliation patterns
- audit/redaction/observability

Reuse the existing HubSpot paths. Do not create a parallel CRM integration stack.

## 1. Provider contract + connection

Implement/register a `hubspot` Connector Framework adapter with only capabilities actually supported.

Use the current official HubSpot app/API authorization model. Before implementation, verify current official HubSpot API/webhook requirements and pin/document any required API/version contract rather than relying on stale assumptions.

Connection requirements:

- OAuth-style authorization through Connector Framework
- scopes requested only for configured objects/features
- contacts minimum read use case
- companies/deals scopes only when enabled
- write scopes only when writeback is explicitly enabled
- token refresh through existing secure credential handling
- secrets never returned/logged
- portal/account identity stored as immutable connection metadata
- revoked/expired permissions classified separately from sync failures

Reuse the provider-neutral connector HTTP surface added in Order 60.

## 2. Configurable object/property selection

Support configurable sync selection for:

### Contacts
- HubSpot contact ID
- approved deterministic identity fields
- lifecycle/stage/state
- configured customer properties

### Companies
- HubSpot company ID
- account/company traits
- contact/company associations

### Deals
- HubSpot deal ID
- amount + currency
- pipeline + stage
- status
- timestamps
- contact/company associations

Do **not** copy every custom property into canonical traits.

Persist an explicit, workspace-scoped, versionable mapping/configuration describing which properties are imported and how they map.

Missing/renamed custom properties must become visible mapping errors, not silent semantic changes.

## 3. Historical backfill

Backfill selected contacts, companies, deals and their required associations.

Requirements:

- HubSpot pagination/batch APIs where appropriate
- durable Connector Framework checkpoint
- resumable after interruption
- idempotent replay
- workspace/portal scoped
- rate-limit aware
- source/provider IDs and timestamps preserved
- associations converge independently of page order

A partial successful backfill must resume rather than restart from zero.

## 4. Canonical mapping

Use provider-neutral canonical services.

Required semantics:

- Contact → canonical Customer + namespaced HubSpot identifier
- approved email/phone identity → Identity Graph v2 using existing normalization/hashing rules
- Company → Account/Company relationship context
- Deal → commercial opportunity/state context
- Contact↔Company / Contact↔Deal / Company↔Deal associations → canonical relationships with HubSpot provenance

Do not implement provider-local identity matching.

A HubSpot deal is **not a purchase event by default**.

## 5. Explicit outcome mapping

Support workspace-configured mappings such as:

`dealstage = closedwon → custom Truvo outcome`

Requirements:

- explicit
- versioned
- testable
- workspace-scoped
- mapping change does not silently rewrite prior history
- no inference from arbitrary stage/property names
- preserve provider timestamp/provenance
- outcome dedup/idempotency uses existing canonical outcome semantics

Do not invent `closedwon = purchase` globally.

## 6. Incremental webhooks — fix known batch bug

Adapt existing HubSpot webhook ingestion into Connector Framework.

**Known defect:** current inbound normalizer recognizes batch payloads but processes only the first event.

Fix this as part of Order 61.

Required:

- verify/authenticate webhook according to current official HubSpot app contract before normalization
- process **every event in the batch**
- isolate failures so one malformed event does not silently discard the rest
- at-least-once delivery safe
- duplicate batch/event harmless
- object/property/association changes converge
- out-of-order events respect provider/source timestamps
- deletion/restoration behavior explicit
- suppression from Order 55 prevents deleted canonical identity/context reconstruction
- webhook verification failures observable

## 7. Reconciliation

Webhooks are not the sole source of incremental truth.

Provide an incremental/reconciliation pull using Connector Framework + existing scheduler so missed notifications can be repaired.

Requirements:

- durable cursor/high-water mark
- leader-locked scheduled execution
- safe repeated ticks
- rate-limit/backoff handling
- idempotent convergence with webhook-applied state
- disconnected/revoked connections not blindly polled

Do not create another scheduler.

## 8. Writeback

Implement opt-in namespaced Truvo writeback to HubSpot records.

Support provider-neutral outbound execution for fields such as:

- Truvo propensity band/score placeholder contract
- Radar name/id
- opportunity value
- last scored timestamp
- other approved namespaced Truvo properties

Important: actual Radar/propensity computation is not part of this Order. Use explicit payloads/fixtures through the destination contract to prove writeback.

Requirements:

- explicit write scope + workspace opt-in
- namespaced Truvo-owned properties
- do not overwrite customer-owned properties unless explicitly mapped
- idempotent write
- correlation/external result recorded
- audit + observability
- retry classification
- property missing/renamed error visible

## 9. Edge cases / runtime proof

Directly test:

- OAuth/scope failure
- revoked credentials
- paginated backfill + checkpoint resume
- webhook batch with multiple events — **all processed**
- duplicate webhook batch
- contact property change
- contact merge
- company association change
- deal reassociation
- deleted/restored object
- custom property missing/renamed
- explicit outcome mapping
- writeback idempotency
- reconciliation after missed webhook
- tenant isolation
- suppression after privacy deletion
- rate-limit/transient retry

Use deterministic official/representative HubSpot fixtures/test doubles plus disposable Postgres 16 and Redis/ClickHouse where the affected path requires them.

No production credentials required.

## Acceptance

- [ ] real HubSpot adapter registered in Connector Framework
- [ ] current official auth/webhook contract verified and documented
- [ ] least-privilege configurable scopes implemented
- [ ] contacts/companies/deals selected backfill works
- [ ] property selection is configurable; no indiscriminate custom-property copy
- [ ] durable checkpoint/resume/idempotency proven
- [ ] provider IDs/timestamps/associations preserved
- [ ] Contact→Customer and Company/Deal relationships canonicalized
- [ ] no provider-local identity matching
- [ ] deal is not purchase without explicit mapping
- [ ] outcome mapping is explicit + versioned + idempotent
- [ ] HubSpot batch webhook processes every event
- [ ] duplicate/out-of-order webhook convergence proven
- [ ] missed-webhook reconciliation proven
- [ ] writeback uses opt-in namespaced Truvo properties
- [ ] writeback idempotency/audit/correlation proven
- [ ] revoked permission and mapping errors visible
- [ ] privacy suppression prevents reconstruction
- [ ] tenant isolation negative tests PASS
- [ ] Order 50 connector contract kit PASS for HubSpot
- [ ] existing HubSpot inbound/outbound behavior remains compatible
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No required real-store/runtime test may be reported PASS if skipped.

## Out of scope

Do not implement:

- Stripe / Klaviyo connectors
- Radar creation
- propensity model training/scoring
- NBA
- campaign orchestration
- fuzzy identity
- arbitrary HubSpot property ingestion
- global `closedwon → purchase` semantics
- broad Connector Framework redesign
- general integrations UI redesign

If HubSpot exposes a framework defect, fix only the smallest provider-neutral defect and add a regression contract test.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- auth/scopes/provider contract
- legacy HubSpot code reused
- selected property/object configuration
- backfill/checkpoint proof
- canonical Contact/Company/Deal/association mapping
- batch webhook all-events proof
- contact merge + reassociation evidence
- explicit outcome mapping
- reconciliation proof
- writeback idempotency/audit proof
- tenant/suppression evidence
- migrations
- exact final validation results
- provider limitations/follow-ups

Do not start Order 62.

End with:

`TRUVO_CODEX_HANDOFF_END`
