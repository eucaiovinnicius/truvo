# ORDER 060 — SHOPIFY CUSTOMER MERGE VERIFICATION

**Execution Order:** 60
**Goal:** close the final Shopify acceptance gap only.

## Current state

Order 60 implementation is committed at:

`4eda74d`

Already proven:

- real Shopify `SourceAdapter`
- pinned Admin GraphQL API version
- provider-neutral commerce schema + migration `0007_futuristic_lady_vermin.sql`
- customers/orders/products/variants/refunds backfill
- durable checkpoint/resume/idempotency
- verified/deduplicated webhooks
- out-of-order convergence
- guest → identified flow
- per-currency deterministic commerce traits
- throttling/retry
- tenant isolation
- suppression/erasure compatibility
- HTTP connection surface
- leader-locked scheduled incremental sync
- API 112/112 PASS, 0 skip
- typecheck/lint/migration validation/build/boot PASS

Do not reimplement Order 60 unless the missing merge proof exposes a real defect.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect only what is needed:
- Shopify adapter + mapper + commerce write path
- `CanonicalMappingService`
- `IdentityGraphService.mergeCustomers`
- canonical customer/context relationships
- `commerce_orders.customer_id`
- purchase outcome dedup logic
- existing Shopify real-Postgres integration tests

## Missing proof

Directly test the explicit Order 60 edge case:

`Shopify sync/customer A → deterministic identity merge A→B → later Shopify webhook/incremental update → one surviving canonical customer B`

Use disposable Postgres 16 and the existing deterministic Shopify provider fixture/test double.

No production/staging data or credentials.

## Required scenario

Create a runtime integration test that proves, at minimum:

1. Shopify customer/order data initially resolves to canonical customer **A**.
2. A second deterministic identity creates/resolves canonical customer **B**.
3. Use the real Order 45 `mergeCustomers` path to merge **A → B**.
4. Replay a realistic subsequent Shopify order/customer/refund update for the original Shopify identity.
5. Assert the Shopify identifier resolves to the surviving canonical customer **B**.
6. Assert subsequent commerce writes attach/converge to **B**, not the merged/deactivated customer **A**.
7. Assert no duplicate `commerce_orders` row for the same provider/order identity.
8. Assert no duplicate purchase `customer_outcomes` row for the same economic order identity.
9. Assert derived commerce traits converge on the surviving customer and do not remain split/stale across A/B.
10. Assert replay remains idempotent.
11. Assert another workspace with identical Shopify/provider IDs is unaffected.

Do not fake the merge by editing customer IDs directly. Exercise the actual `IdentityGraphService.mergeCustomers` mechanism.

## Repair rule

If the proof fails:

- fix only the smallest provider-neutral correctness defect;
- prefer fixing canonical/identity/commerce convergence rather than adding Shopify-specific merge logic;
- add a regression test;
- do not redesign Connector Framework or Identity Graph.

If current merge semantics intentionally require a separate reconciliation step, make that step explicit, idempotent and provider-neutral, then prove it.

## Final gate

After the merge proof passes, run:

```bash
pnpm migration:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If affected integration tests require disposable Postgres/Redis/ClickHouse, run the full relevant real-infra suite and report exact counts with **0 relevant skip**.

## Definition of Done

Return `DONE` only when the Shopify customer-merge integration is directly runtime-proven and the final regression gate remains green.

Do not start Order 61.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- exact merge scenario
- A→B identity evidence
- Shopify identifier resolution after merge
- order/outcome dedup evidence
- derived-trait convergence
- replay idempotency
- tenant-isolation evidence
- any code fix made
- exact final validation results

End with:

`TRUVO_CODEX_HANDOFF_END`
