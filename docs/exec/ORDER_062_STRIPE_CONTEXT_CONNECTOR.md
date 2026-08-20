# ORDER 062 — STRIPE CONTEXT CONNECTOR

**Priority:** P0
**Phase:** MVP
**Status:** Ready / Build Ready
**Reuse:** Adapt existing Stripe webhook normalization + Connector Framework

## Goal

Implement Stripe as a real **Source connector** for canonical billing, payment and subscription context suitable for subscription, upgrade, retention and revenue Radars.

A workspace must be able to:

`connect Stripe → identify account → historical billing backfill → verified webhook + reconciliation → canonical customer/subscription/invoice/payment state → deterministic billing traits`

Do not put Radar/ML logic inside the adapter.

## Preflight

Order 61 closure is DONE at:

`12b8e29`

Inspect `git status` first and preserve user execution docs.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Inspect first

- Order 50 Connector Framework + shared contract kit
- Order 60 Shopify adapter/commerce patterns
- Order 61 HubSpot multi-stream/reconciliation patterns
- existing Stripe webhook normalizers/producers
- existing billing/subscription/payment schemas, if any
- EventSchema economic/lifecycle mappings
- Customer Context + Identity Graph v2
- Order 40 outcome projection/dedup
- Order 55 suppression/erasure
- scheduler/reconciliation
- credential/audit/redaction/observability patterns

Reuse mature Stripe event code. Do not create a parallel webhook pipeline.

## 1. Provider contract + authorization

Implement/register a `stripe` Connector Framework source adapter.

Before implementation, verify the **current official Stripe multi-tenant authorization and webhook contract** from official Stripe documentation.

Requirements:

- use an approved multi-tenant authorization model appropriate for a SaaS connector;
- do **not** design the product around users pasting unrestricted Stripe secret keys;
- identify and persist the represented Stripe account as immutable connection metadata;
- request/use only access required by implemented read/webhook capabilities;
- support credential/account validation and clean deauthorization;
- secret material stays inside existing Connector Framework credential storage and never returns from API/logs;
- revoked/invalid authorization is distinct from sync-health failures.

Pin/document any provider API version or account-mode assumption required for deterministic behavior.

Do not add a second secret/auth framework.

## 2. Historical backfill

Backfill, where available/enabled:

### Customers
- Stripe customer ID
- approved deterministic identity fields
- source timestamps / metadata needed for identity provenance

### Subscriptions
- subscription ID
- customer
- status
- start timestamps
- trial boundaries
- current period boundaries
- cancel-at / canceled-at / ended-at semantics
- quantity
- current product/price/plan references
- collection/payment behavior needed for state

### Invoices
- invoice ID
- customer/subscription linkage
- status
- currency
- amount due/paid/remaining where semantically relevant
- created/finalized/paid/void/uncollectible timestamps as available

### Payments
- provider payment/payment-intent/charge identity as appropriate to current Stripe model
- success/failure state
- amount/currency
- invoice/subscription/customer linkage
- failure context needed for deterministic billing traits

### Refunds / credit adjustments
- provider identity
- amount/currency
- linked payment/invoice where available
- source timestamp/state

Requirements:

- provider pagination through Connector Framework;
- durable workspace/account/stream checkpoints;
- resumable after interruption;
- idempotent replay;
- rate-limit/transient-failure aware;
- provider IDs preserved;
- source timestamps preserved;
- partial successful backfill resumes instead of restarting.

Use multiple incremental streams if the provider requires independent checkpoints.

## 3. Provider-neutral billing state

Inspect existing v3.2/v4 schemas first.

If current models cannot represent required durable billing/subscription state, add only the minimum **provider-neutral additive** schema.

Prefer entities equivalent to:

- Subscription
- Invoice
- Payment
- Billing Adjustment / Refund

Do not create Stripe-specific canonical tables/columns when provider-neutral fields + namespaced metadata suffice.

Stripe Product/Price references are **commercial plan references**, not automatically Truvo Product/catalog truth.

State must be workspace-scoped and provider/connection-attributed.

## 4. Canonical customer + identity mapping

Required semantics:

- Stripe Customer ID → namespaced external identifier;
- approved email/phone → existing shared deterministic identity namespace;
- Customer resolution goes through Identity Graph v2;
- suppression from Order 55 must block accidental recreation;
- same Stripe IDs in different Truvo workspaces must never collide.

Do not implement provider-local identity matching.

A guest/unlinked payment may remain billing data without fabricating a customer identity until deterministic evidence exists.

## 5. Subscription state + deterministic traits

Materialize only recomputable/time-aware state such as:

- current subscription status
- current plan/product/price reference
- current quantity
- trial state / trial end
- subscription tenure
- current/next period boundaries
- cancel scheduled vs effectively canceled
- last successful billing/payment timestamp
- payment-failure count/history
- billing recency
- active subscription count

Requirements:

- use provider/source timestamps;
- stale/out-of-order state cannot overwrite newer state;
- multiple subscriptions per customer are supported;
- traits derived from multiple subscriptions must use explicit deterministic aggregation rules;
- currency-specific monetary aggregates remain separated where currencies differ.

Do not silently collapse multiple subscriptions into one.

## 6. Verified incremental webhooks

Adapt existing Stripe webhook normalization into Connector Framework.

Handle relevant current lifecycle events for:

- customer changes needed for identity/context
- subscription create/update/delete/status transitions
- invoice lifecycle
- payment success/failure
- refunds/credit adjustments

Requirements:

- verify Stripe webhook authenticity before normalization;
- preserve provider event ID and use it for at-least-once idempotency;
- duplicate event harmless;
- each event applies through canonical mapping, not provider-local writes;
- out-of-order delivery converges using source timestamps/version/state;
- one failed projection cannot silently lose the durable provider event;
- invalid signature fails closed + observable;
- privacy suppression prevents canonical identity/context recreation.

Preserve existing PRD events such as `subscription_started`, `subscription_cancelled`, `payment_received`, `purchase` and `refund` **only where semantics genuinely match**.

Do not rename/mutate historical raw events.

## 7. Avoid duplicate economic truth

Stripe may describe economic activity that also arrives from Shopify or the existing event pipeline.

Do not create a competing purchase/payment truth.

Before mapping provider events to existing canonical outcomes/economic events:

- inspect current natural keys/dedup rules;
- reuse provider/event/order/invoice/payment IDs deterministically;
- preserve source provenance;
- prove replay cannot duplicate outcomes;
- do not turn every successful Stripe payment into a `purchase` if the existing semantic contract says `payment_received` or recurring billing is more accurate.

For recurring billing, prefer explicit billing/subscription semantics over ecommerce assumptions.

## 8. Upgrade / downgrade semantics

A change from one arbitrary Stripe `price_id` to another is **not enough** to infer upgrade/downgrade.

Implement a workspace-scoped, explicit, versioned commercial-plan mapping/comparison mechanism if upgrade/downgrade outcomes are supported in this Order.

Examples of explicit information may include:

- plan tier/rank
- comparable unit/effective value
- product family
- mapping version/effective date

Requirements:

- old/new subscription state comparison is deterministic;
- quantity-only changes are distinguishable from plan changes;
- upgrade/downgrade is emitted only when mapping makes direction unambiguous;
- ambiguous/unmapped change remains a neutral plan change;
- mapping changes do not silently rewrite prior outcome history;
- outcome is idempotent/version-attributed.

Never infer commercial direction from lexicographic/numeric `price_id` ordering.

## 9. Reconciliation

Webhooks are not the sole source of truth.

Provide scheduled/manual reconciliation through the existing Connector Framework/SchedulerService.

Prove:

- missed webhook is repaired by pull;
- durable high-water/checkpoint state;
- repeated reconciliation is idempotent;
- active subscription/invoice/payment state converges with webhook-applied state;
- disconnected/revoked connections are handled deliberately;
- no second scheduler is created.

## 10. Required edge cases

Directly test:

- historical backfill
- trial → active
- past_due → active after successful retry
- cancellation scheduled but not yet effective
- effective cancellation
- plan/price change
- quantity-only change
- explicitly mapped upgrade
- explicitly mapped downgrade if mapping supports it
- unmapped/ambiguous plan change produces no false upgrade/downgrade
- invoice retry / payment failure → success
- duplicate webhook
- out-of-order subscription events
- refund after cancellation
- multiple subscriptions per customer
- deauthorization/revoked authorization
- missed-webhook reconciliation
- tenant isolation
- privacy suppression
- identical Stripe object IDs across workspaces
- customer identity merge followed by later Stripe update
- multiple currencies where monetary context exists

Use official/representative Stripe fixtures and deterministic provider test doubles. Use disposable Postgres 16 and Redis/ClickHouse where affected paths require them. No production credentials are required.

## 11. Shared contract kit

Run the actual reusable Order 50 Connector Framework contract kit against the real Stripe adapter for every applicable capability.

Do not substitute a Stripe-only "equivalent" test suite.

Capability-aware fixture/test-driver parameterization is allowed, but shared assertions must not be weakened.

Keep fake-provider, Shopify and HubSpot regression contract behavior green.

## Acceptance

- [ ] real Stripe source adapter registered
- [ ] current official multi-tenant authorization/webhook contract verified + documented
- [ ] unrestricted pasted secret keys are not the product connection model
- [ ] represented Stripe account identity/deauthorization implemented
- [ ] customers/subscriptions/invoices/payments/refunds historical backfill works
- [ ] durable checkpoint/resume/idempotency proven
- [ ] provider IDs and source timestamps preserved
- [ ] provider-neutral billing/subscription state exists/reused
- [ ] Stripe Customer identity uses Identity Graph v2
- [ ] multiple subscriptions per customer supported
- [ ] deterministic current billing/subscription traits materialized
- [ ] stale/out-of-order webhook cannot regress newer state
- [ ] verified provider-event-id webhook dedup proven
- [ ] trial/past_due/cancellation lifecycle proven
- [ ] recurring successful payment semantics remain distinct from ecommerce purchase where appropriate
- [ ] no duplicate economic outcome truth across replay/source overlap
- [ ] refund/adjustment linkage proven
- [ ] plan change does not imply upgrade/downgrade without explicit mapping
- [ ] explicit mapped upgrade/downgrade comparison is versioned/idempotent if implemented
- [ ] reconciliation repairs missed webhook
- [ ] customer merge followed by Stripe update converges to surviving customer
- [ ] privacy suppression prevents reconstruction
- [ ] tenant isolation negative tests PASS
- [ ] actual shared Order 50 contract kit PASS for Stripe
- [ ] existing Stripe webhook/event compatibility preserved
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No required runtime/real-store test may be reported PASS if skipped.

## Out of scope

Do not implement:

- Klaviyo connector
- Radar UI
- propensity / MLOps
- NBA
- subscription-pricing optimization
- Stripe as Truvo catalog truth
- fuzzy identity
- arbitrary provider metadata ingestion
- broad Connector Framework redesign
- general integrations UI redesign

If Stripe exposes a genuine framework defect, fix only the smallest provider-neutral defect and add shared regression coverage.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- Stripe authorization/API/webhook contract
- legacy Stripe code reused
- adapter capabilities
- billing schema reused/added
- historical backfill/checkpoint evidence
- Customer/Subscription/Invoice/Payment/Refund canonical mapping
- subscription-state/trait derivation rules
- lifecycle fixture sequence
- webhook verification/dedup/out-of-order proof
- plan change + upgrade/downgrade mapping evidence
- economic dedup/source-overlap evidence
- merge + suppression + tenant evidence
- reconciliation proof
- shared contract-kit result
- migrations
- exact final validation results
- provider limitations/follow-ups

Do not start Order 63.

End with:

`TRUVO_CODEX_HANDOFF_END`
