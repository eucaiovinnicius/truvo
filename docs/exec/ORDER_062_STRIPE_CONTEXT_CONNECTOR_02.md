# ORDER 062 — STRIPE CONTEXT CONNECTOR — CLOSURE 02

**Execution Order:** 62
**Goal:** close the remaining runtime, shared-contract and authorization-model gates only.

## Current state

The first Stripe implementation pass is **PARTIAL** and currently lives in an **uncommitted worktree** on top of:

`12b8e29`

Implemented already:

- real source-only Stripe Connector Framework adapter
- signed-state OAuth connection/deauthorization flow
- pinned Stripe API version
- verified Stripe webhook signatures + provider event-id dedup
- additive provider-neutral billing schema
- migration `0010_chubby_blink.sql`
- customer/subscription/invoice/payment/refund normalized mappings
- deterministic billing traits
- stale source-timestamp protection
- per-stream checkpoint/reconciliation wiring
- unit tests for OAuth, five streams, webhook signature and out-of-order mapping
- install/migration validation/lint/typecheck/build green

Do **not** reimplement this work unless a required runtime proof exposes a real defect.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

Do not start Order 63.

## 1. Preserve and audit the uncommitted implementation

Before editing:

```bash
git status
git diff --stat
git diff
git log -1
```

Verify that the current worktree actually contains the implementation described in the prior handoff.

Do not discard or regenerate `0010_chubby_blink.sql` unless migration validation/runtime bootstrap proves it defective.

Keep user execution docs intact.

## 2. Resolve the Stripe authorization-model gate

Official Stripe documentation currently distinguishes two different use cases:

- new **Connect platforms**: OAuth is not the recommended onboarding path;
- **extensions/apps that access an existing Stripe account**: OAuth remains a supported model, and Stripe Apps also supports OAuth 2.0.

Truvo's product intent is data/revenue intelligence over a merchant's existing Stripe account, not onboarding payment recipients or operating a marketplace.

### Required decision

Classify the Stripe integration explicitly as one of:

- third-party extension/app over existing Stripe accounts; or
- Connect platform that onboards/manages connected accounts.

Then verify the implemented auth path against current official Stripe docs.

Rules:

- do **not** change authentication merely because "OAuth is not recommended for new Connect platforms";
- if Truvo is correctly classified as an extension/app and the existing Connect OAuth flow is supported for that use case, document the justification and preserve the implementation;
- if current Stripe requirements make Stripe Apps OAuth 2.0 or another approved model the correct production path, adapt only the smallest provider-neutral/auth-specific surface needed;
- unrestricted pasted secret keys remain prohibited;
- preserve encrypted credential storage, immutable account identity, deauthorization and secret redaction.

Record the conclusion in the handoff so the Notion Open Question can be resolved.

A live production Stripe account is not required to make the classification.

## 3. Diagnose the hanging real-Postgres harness

The prior attempt remained pending after the first orchestrator cycle.

Find the concrete lifecycle leak/deadlock instead of weakening or skipping the test.

Inspect likely resources used by the affected path:

- Postgres pools
- Redis clients
- scheduler timers/leader locks
- connector orchestrator retry timers
- HTTP/provider test double lifecycle
- Kafka/ClickHouse clients if instantiated indirectly
- open server/listener handles

Requirements:

- the required integration test process exits cleanly;
- no arbitrary forced `process.exit()` masking a leaked handle;
- teardown uses established shared close helpers where available;
- if a shared framework leak is found, fix the smallest provider-neutral defect and add regression coverage.

## 4. Run the actual shared Order 50 contract kit against Stripe

Do not substitute a Stripe-only equivalent suite.

Reuse/extend the shared driver mechanism already proven for HubSpot.

Run every applicable source-connector proof, including at least:

- capability declaration
- connection lifecycle/test semantics
- credential failure separate from sync health
- initial backfill + durable checkpoint resume
- transient retry then success
- permanent/auth failure stop
- rate-limit reschedule
- duplicate webhook harmless
- invalid webhook signature fail-closed
- canonical mapping through Identity Graph / Customer Context

Stripe is source-only, so destination-only proofs may be capability-gated as genuinely inapplicable.

Do not weaken shared assertions.

Fake-provider and HubSpot shared-kit regression tests must remain green.

## 5. Real runtime lifecycle proof

Use disposable/local infrastructure only.

At minimum:

- Postgres 16
- Redis when identity/orchestration requires it
- ClickHouse where the affected economic/event path requires it

No production/staging data.

Use representative Stripe fixtures and a deterministic provider HTTP test double.

Directly prove the following through the normal Connector Framework/canonical path.

### Historical sync

- customers
- subscriptions
- invoices
- payments
- refunds/adjustments
- pagination
- checkpoint resume
- repeated page/replay idempotency

### Subscription lifecycle

- trial → active
- `past_due` → active after successful retry/payment
- scheduled cancellation remains distinguishable from effective cancellation
- effective cancellation
- quantity-only change
- plan/price change
- multiple subscriptions for one customer

### Out-of-order safety

Apply a newer subscription state, then an older webhook/update.

Assert the older source timestamp cannot regress canonical state or traits.

### Economic semantics

Prove:

- recurring successful billing is not blindly converted into ecommerce `purchase`;
- provider event replay does not duplicate economic outcomes;
- invoice/payment/refund linkage is preserved;
- refund after cancellation is retained correctly;
- multi-currency monetary context is not falsely summed across currencies.

Do not invent refund-reversal semantics that remain deferred elsewhere.

### Upgrade / downgrade

The first pass intentionally did not implement upgrade/downgrade outcomes.

That is acceptable for Order 62 **if**:

- arbitrary `price_id` change stays a neutral plan change;
- no false upgrade/downgrade outcome is emitted;
- the missing commercial-plan ranking/mapping is clearly documented as a later consumer decision.

Do not add a rushed pricing taxonomy merely to tick a box.

## 6. Identity merge, suppression and tenant isolation

Directly prove with real Postgres:

### Merge

1. Stripe customer resolves to canonical customer A.
2. A second deterministic identity resolves to B.
3. Use real `IdentityGraphService.mergeCustomers(A→B)`.
4. Process a later Stripe subscription/invoice/payment update for the original Stripe identity.
5. Stripe identifier resolves to B.
6. Durable billing rows/context converge to B where customer attribution is mutable/current.
7. No duplicate natural billing/economic rows are created.

Do not simulate merge by editing customer IDs.

### Privacy suppression

- suppress/delete a Stripe-linked identity via existing Order 55 mechanism;
- replay a historical Stripe customer/subscription/payment update;
- prove canonical identity/context is not silently recreated.

### Tenant isolation

- same Stripe account/customer/subscription/payment IDs in another workspace remain independent;
- deauthorization/reconciliation in one workspace cannot mutate another.

## 7. Reconciliation + authorization failure

Prove:

- missed webhook is repaired by incremental reconciliation;
- repeated reconciliation is idempotent;
- revoked/deauthorized Stripe connection is not blindly polled;
- auth failure is classified separately from ordinary sync failure;
- connection health and credential validity stay distinct.

## 8. Migration/runtime DB gate

Because `0010_chubby_blink.sql` is new, prove:

1. clean disposable Postgres 16 bootstrap from zero through migration 0010;
2. expected billing tables/constraints/indexes exist;
3. second migration run is a safe no-op;
4. no destructive change to existing M11 `subscriptions` or prior canonical tables.

Run:

```bash
pnpm migration:validate
```

No schema runtime proof may be replaced by structural-only assertions.

## 9. Test-skip rule

The prior generic test run reported:

`108 passed, 18 environment-skipped`

That does not by itself block closure if those skips are unrelated legacy/environment suites.

However:

- every **Order 62 required proof** must run with zero skip;
- shared Stripe contract-kit tests must have zero skip for applicable capabilities;
- Stripe lifecycle/merge/suppression/tenant tests must have zero skip;
- report exact full-suite skip names/counts and explain why none correspond to Order 62 acceptance.

If relevant tests skip because infrastructure is unavailable, the Order remains PARTIAL.

## 10. Commit gate

The implementation is currently uncommitted.

Only after all required proofs pass:

- inspect final `git diff`;
- commit the Order 62 implementation/closure;
- report exact before and after hashes;
- report final `git status`.

Do not claim `DONE` with the implementation still only in an uncommitted worktree.

## Final validation

Run the complete gate:

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also report separately:

- Stripe shared contract-kit count
- Stripe lifecycle integration count
- merge/suppression/tenant count
- real-infra environment used
- exact relevant skip count = **0**

## Definition of Done

Return `DONE` only when:

- the real Stripe adapter passes the actual shared Order 50 contract kit;
- the hanging runtime harness is diagnosed and exits cleanly;
- required subscription/payment/refund lifecycle scenarios pass on real disposable infrastructure;
- out-of-order state convergence is proven;
- merge/suppression/tenant isolation are proven;
- recurring billing/economic dedup semantics are proven;
- missed-webhook reconciliation is proven;
- clean migration bootstrap + second-run no-op pass;
- Stripe authorization model is explicitly classified and justified against current official Stripe guidance;
- the implementation is committed;
- final lint/typecheck/test/build gates remain green with zero relevant skip.

Do not start Order 63.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- final authorization-model decision and official Stripe basis
- exact auth implementation preserved/changed
- runtime-harness root cause
- shared contract-kit exact results
- lifecycle fixture results
- economic semantics/dedup proof
- merge/suppression/tenant proof
- reconciliation/deauthorization proof
- migration clean-bootstrap/no-op proof
- exact full-suite skip accounting
- exact final commit hash
- residual Stripe limitations

End with:

`TRUVO_CODEX_HANDOFF_END`
