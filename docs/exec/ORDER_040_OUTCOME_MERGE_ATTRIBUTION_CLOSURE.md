# ORDER 040 — OUTCOME MERGE ATTRIBUTION CLOSURE

**Execution Order:** 40  
**Goal:** close one provider-neutral outcome-attribution regression discovered by Order 60.

## Current state

Order 60 is DONE at:

`b2c6645`

Its customer-merge verification proved and fixed this behavior in `CommerceWriteService`:

`customer A → IdentityGraphService.mergeCustomers(A→B) → later write for same economic order → existing customer_outcomes row advances to surviving customer B without duplication`

The same stale-attribution pattern still exists in Order 40's `EventProjectionService`.

Do not reopen or redesign the rest of Order 40.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect only:
- `EventProjectionService`
- outcome projection registry/rules
- `customer_outcomes` natural key/dedup behavior
- Order 40 compatibility tests
- Order 45 `IdentityGraphService.mergeCustomers`
- Order 60 commerce-path fix + merge test

## Defect

Current raw/event-pipeline outcome insertion uses first-write-wins behavior (`onConflictDoNothing` or equivalent).

If:

1. purchase outcome is projected for canonical customer **A**;
2. Identity Graph later merges **A → B**;
3. the same economic event/order is replayed or reprocessed under current identity resolution;

the existing outcome can remain attributed to merged-away **A**.

This creates split attribution between the event pipeline and the canonical surviving customer.

## Required fix

Apply the smallest provider-neutral change so that, on conflict for the **same natural economic outcome**, the outcome's `customerId` advances to the **currently resolved canonical customer**.

Preserve all other immutable/source semantics unless the existing accepted spec explicitly says otherwise.

In particular:

- do not create a second outcome row;
- preserve existing dedup key behavior;
- preserve original value/currency semantics;
- preserve original observed/source timestamp semantics unless current code already updates them by design;
- only advance attribution fields required for identity convergence (`customerId`, and ordinary `updatedAt` if present);
- never trust a client-supplied customer id over canonical identity resolution;
- no Shopify/provider-specific logic.

## Runtime proof

Use disposable Postgres 16.

Add a direct integration test using the real pipeline/services:

1. create/resolve customer **A**;
2. project a purchase event/order and assert exactly one `customer_outcomes` row belongs to A;
3. create/resolve customer **B**;
4. call the real `IdentityGraphService.mergeCustomers(A→B)`;
5. replay/reprocess the same purchase event through `EventProjectionService`;
6. assert exactly one outcome still exists for the same natural key;
7. assert that outcome now belongs to **B**;
8. assert value, currency and original outcome/economic identity remain unchanged;
9. assert another replay is idempotent;
10. assert identical event/order identifiers in another workspace remain isolated.

Do not simulate the merge by editing rows manually.

## Compatibility guard

Prove the fix does **not** change:

- EventSchema
- pixel/server-side/webhook normalized event contracts
- `event_id` / `order_id` dedup semantics
- source priority
- ClickHouse raw event history
- refund/subscription-cancelled reversal semantics

The previously deferred refund/reversal policy stays deferred.

## Final gate

Run:

```bash
pnpm migration:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the relevant real-Postgres suite with **0 relevant skip** and report exact counts.

No migration should be needed unless the existing schema unexpectedly prevents the correct fix.

## Definition of Done

Return `DONE` only when:

- raw/event-pipeline outcome attribution follows an Identity Graph merge to the surviving customer;
- no duplicate economic outcome is created;
- immutable value/currency/source semantics remain compatible;
- tenant isolation is proven;
- full regression gate is green.

Do not start Order 61.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- exact defect/fix
- A→B runtime proof
- outcome dedup + attribution evidence
- immutable-field compatibility evidence
- tenant isolation
- exact final validation results

End with:

`TRUVO_CODEX_HANDOFF_END`
