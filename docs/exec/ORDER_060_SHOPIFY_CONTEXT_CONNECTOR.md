# ORDER 060 — SHOPIFY CONTEXT CONNECTOR

**Priority:** P0
**Phase:** MVP
**Status:** Ready / Build Ready
**Reuse:** Adapt existing Shopify webhooks + Order 50 Connector Framework

## Goal

Implement Shopify as Truvo's **first real Source connector**, producing reliable canonical commerce/customer context for purchase, rebuy and cross-sell use cases.

A new workspace must be able to:

`connect Shopify → validate credentials/scopes → backfill history → resume from checkpoints → ingest verified webhooks → stay synchronized → expose canonical commerce context`

Do not put Radar/ML logic inside the adapter.

## Preflight

Order 55 is DONE at:

`8ce905a1bd89d13175ec3c9a458dc92b599ae17e`

Inspect `git status` first and preserve user execution docs.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Inspect first

- Order 50 connector contracts/services/test kit
- existing Shopify webhook ingestion/normalizers
- existing `/v1/integrations` Shopify behavior
- existing order/product/commerce Postgres/ClickHouse schemas
- EventSchema purchase/refund mappings
- Order 30 Customer Context
- Order 40 customer outcomes/projection
- Order 45 Identity Graph v2
- Order 55 suppression/erasure behavior
- SchedulerService leader-lock pattern
- credential encryption/redaction/audit patterns

Reuse existing Shopify code. Do not create a second webhook pipeline.

## 1. Provider contract

Implement a real `shopify` Connector Framework adapter.

Use the **Shopify Admin GraphQL API** as the primary read interface.

Before implementation, verify the currently supported stable API version from official Shopify documentation and pin an explicit version in code/config. Never use an unversioned endpoint. Do not silently upgrade provider API versions.

The adapter must declare only capabilities actually implemented.

## 2. Connection + minimal HTTP surface

This is the first real adapter, so close Order 50's deferred HTTP-surface decision with the **minimum provider-neutral/public routes required** for:

- create/start Shopify connection
- complete authorization/callback where applicable
- test connection/scopes
- trigger initial sync
- inspect connection health/sync state
- disconnect

Reuse/adapt existing `/v1/integrations` routes when compatible; do not create competing Shopify concepts.

Requirements:

- immutable shop identity/domain metadata
- least-privilege scopes for required customer/order/product reads + required webhooks
- credentials/tokens stored only through Connector Framework secret handling
- stored tokens never returned to clients/logs
- authorization/test failure separated from sync-health failure
- audit connection lifecycle

Do not build general integrations UI.

## 3. Historical backfill

Backfill at minimum:

- customers + Shopify customer IDs
- orders
- financial status
- source timestamps
- totals + currency
- customer linkage
- line items
- product/variant IDs
- quantity + price
- products/variants needed for cross-sell context
- refunds relevant to realized revenue

Use Shopify-supported paginated/bulk patterns as appropriate.

Requirements:

- durable Connector Framework checkpoints
- resumable after interruption
- idempotent replay
- rate-limit aware
- workspace/shop scoped
- no full restart after a partial successful backfill

Preserve provider IDs and source timestamps for auditability.

## 4. Canonical mapping

Use Connector Framework `CanonicalMappingService`, Identity Graph v2 and existing commerce/event models.

Required mappings:

- Shopify customer ID → namespaced Shopify identifier
- customer/contact deterministic identifiers → Identity Graph v2, subject to suppression
- order → existing/provider-neutral commerce representation + economic event semantics
- paid order → existing purchase semantics
- line item → product/variant relationship/history
- refund → revenue adjustment/refund event linked to original order
- deterministic commerce state/traits → Customer Context

Do not implement provider-local identity matching.

If current commerce tables cannot represent required state, add only the minimum **provider-neutral additive** schema after inspecting existing models. Do not add Shopify-specific columns to canonical core when namespaced metadata/relationships suffice.

## 5. Deterministic derived context

Materialize only recomputable commerce context such as:

- order count
- last purchase timestamp
- realized revenue
- AOV
- product/variant history
- category/product history
- refund history

Derived aggregates must converge from canonical source data after backfill + incremental updates.

Out-of-order events must not let stale provider state overwrite newer state.

Multiple currencies must not be silently summed into a false single-currency revenue/AOV value.

## 6. Incremental webhooks

Adapt the existing Shopify webhook path into the Connector Framework rather than duplicating it.

Support relevant order/refund/customer/product lifecycle updates required for the backfilled model.

Required:

- verify Shopify signature before normalization
- use provider delivery/resource identity when available
- at-least-once delivery safe
- duplicate webhook harmless
- preserve economic `event_id`/`order_id` dedup semantics from Order 40
- out-of-order updates converge correctly
- invalid signature fails closed + observable
- suppression from Order 55 prevents deleted identity/context reconstruction

## 7. Scheduled incremental sync

Close Order 50's deferred scheduler decision for the first source adapter.

Wire active Shopify connections into the existing leader-locked SchedulerService pattern.

Requirements:

- workspace/connection scoped
- uses Connector Framework `runIncremental`
- checkpointed
- safe under repeated scheduler ticks
- provider throttling pauses/reschedules
- disabled when `SCHEDULER_ENABLED` is false, consistent with existing jobs
- disconnected/error-authorized states are handled deliberately, not blindly polled

Do not create a second scheduler.

## 8. Edge cases

Explicitly handle/test:

- guest checkout without Shopify customer
- guest → identified later
- customer merge
- partial refund
- full refund
- order edited after payment
- duplicate webhook
- out-of-order webhook
- repeated historical page
- multiple currencies
- product/variant deleted after historical purchase
- Shopify throttling / transient failure
- disconnected/revoked credentials
- same Shopify IDs in two Truvo workspaces

Do not invent refund reversal semantics for `customer_outcomes` if the deferred Order 40 decision is still unresolved. Preserve refund as its own economic adjustment/event unless an accepted current ADR/spec says otherwise.

## Runtime / contract validation

No production Shopify credentials are required for acceptance.

Use:

- official/representative Shopify GraphQL + webhook fixtures
- deterministic HTTP/provider test double for GraphQL pagination, throttling and auth failure
- Order 50 reusable adapter contract kit
- disposable Postgres 16 and Redis/ClickHouse where the affected path requires them

If a live Shopify dev store is already safely configured, it may be used as supplementary evidence, never as the sole proof.

## Acceptance

- [ ] Shopify real adapter registered in Connector Framework
- [ ] explicit supported Shopify API version pinned
- [ ] least-privilege connection/scopes + immutable shop metadata implemented
- [ ] minimum public connection/test/sync/health/disconnect surface works
- [ ] stored Shopify secret material never leaks
- [ ] customers/orders/line items/products/variants/refunds backfill works
- [ ] backfill checkpoint/resume/idempotency proven
- [ ] rate-limit/throttling resume proven
- [ ] Shopify customer IDs are provider-namespaced
- [ ] guest → identified flow converges correctly
- [ ] paid order preserves purchase semantics/dedup
- [ ] partial/full refund mapping is linked to original order
- [ ] deterministic commerce traits/aggregates are recomputable
- [ ] currency handling does not create false aggregates
- [ ] verified incremental webhooks converge with backfill state
- [ ] duplicate + out-of-order webhook proofs PASS
- [ ] invalid webhook signature rejected
- [ ] deleted/suppressed subject is not reconstructed
- [ ] tenant isolation negative tests PASS
- [ ] scheduled incremental sync uses existing leader-lock scheduler
- [ ] existing Shopify/webhook/integration behavior remains compatible
- [ ] Order 50 adapter contract suite PASS for Shopify
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No required runtime/real-store test may be called PASS if skipped.

## Out of scope

Do not implement:

- HubSpot / Stripe / Klaviyo adapters
- Radar code
- propensity / ML / NBA
- campaign activation
- general integrations UI redesign
- fuzzy identity matching
- unrequested refund→purchase reversal policy
- broad Connector Framework redesign

If Shopify reveals a genuine framework defect, fix the smallest provider-neutral defect and add a regression contract test.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- Shopify API version/scopes
- legacy Shopify code reused
- adapter capabilities
- HTTP connection surface
- backfill/checkpoint evidence
- canonical customer/order/product/refund mapping
- guest→identified proof
- webhook verification/dedup/out-of-order proof
- throttling/retry proof
- scheduled incremental sync proof
- tenant/suppression evidence
- migrations if any
- exact final validation results
- any provider constraint requiring a framework follow-up

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
