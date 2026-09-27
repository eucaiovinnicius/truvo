# ORDER 130 — QA & Workspace de Demonstração v1 — Review Closure 02

## Execution authority

- **Execution Order:** 130
- **Work Item:** QA & Workspace de Demonstração v1 — Review Closure 02
- **Baseline branch:** `main`
- **Baseline SHA:** `aba7cfa8b4f72bb8cae6bbafbb687797065344be`
- **Original PR:** `#2`
- **Original final branch SHA:** `7fd07fc244629588027aa3e45824b5ca03e21a58`
- **Original merge SHA:** `aba7cfa8b4f72bb8cae6bbafbb687797065344be`
- **Post-merge CI:** `36296241998` — SUCCESS
- **Recommended closure branch:** `order-130-qa-demo-review-closure-02`
- **Priority:** P0
- **Scope:** only post-merge residual findings from the final Codex review
- **Next item blocked:** Order 150

## Why this closure exists

PR #2 was merged before the final Codex review on the exact final branch head finished. That final review completed after the merge and opened two P2 findings that are present in `main`.

This is an objectively new post-merge residual, so a new immutable closure authority is justified.

Do not reopen already-closed review findings unless the closure changes regress them.

## Residual finding 1 — Nest-managed demo model promotion uses production artifact verification

`QaDemoWorkspaceService` receives the production `ModelRegistryService` through Nest DI.

The demo seed inserts a synthetic/fictitious model artifact reference and checksum but does not upload a real artifact. `ModelRegistryService.promote()` verifies artifact integrity before promotion. Therefore the Nest-managed path can fail with artifact unavailable / verifier errors even though the standalone factory works because it uses a fake verifier.

Required outcome:

- the demo/QA path must use an explicitly demo-scoped model registry or artifact verifier;
- fake/demo verification must never pollute the production model registry or production DI path;
- both standalone CLI/test construction and Nest-managed `QaDemoWorkspaceService` must behave consistently;
- model promotion must still exercise the canonical lifecycle semantics;
- no production artifact verification should be weakened.

Also restore/prove the intended reset guarantee: a failed seed must not leave a previously valid demo workspace erased or partially rebuilt. Cleanup + reseed must be atomic, or an equivalent design must prove preservation on failure.

Required tests:

1. Resolve `QaDemoWorkspaceService` through Nest DI.
2. Seed/reset a demo workspace successfully.
3. Assert the demo model becomes active.
4. Assert no live/production model registry configuration is modified.
5. Force a deterministic failure after reset has started and prove the previous complete demo dataset remains intact.
6. Re-run normally and prove a complete deterministic dataset is committed.

## Residual finding 2 — entityCounts under-reports anonymous identity-transition rows

For the `likely_buyer` identity transition, the seeder persists:

- one additional anonymous customer;
- one additional anonymous cookie/anonymous identifier.

But `customersCount` and `identifiersCount` are not incremented.

The service/CLI inventory therefore reports counts that disagree with persisted state, and the golden E2E currently enforces the incorrect count.

Required outcome:

- reported `entityCounts` must reflect actual persisted demo inventory;
- anonymous identity-transition customer and identifier must be counted;
- replay must keep logical counts deterministic;
- the golden E2E must verify returned counts against actual DB counts instead of duplicating a wrong hard-coded expectation.

Expected current logical inventory must be derived from the dataset and canonical merge behavior, not guessed. If DB state is 7 customers / 15 identifiers, prove that directly.

## Regression requirements

Before finalizing, prove that all previously fixed Order 130 invariants remain intact:

- demo workspace destructive safety guard remains fail-closed;
- `ACTIVE_WORK_ITEM.md` has no diff;
- canonical opportunity tables are used;
- DB-backed `test:demo-workspace` is mandatory and cannot pass without a reachable migrated DB;
- tenant isolation remains real and DB-backed;
- golden E2E remains DB-backed;
- replay remains idempotent and scoped to the deterministic demo activation;
- pre-existing users and unrelated memberships remain preserved;
- fake connector registry remains isolated to demo;
- connector contract fixtures remain sanitized;
- malformed Stripe payload handling remains correct;
- identity merge uses canonical persisted evidence;
- release/pre-beta gate remains wired.

## Validation

After the last code/test change run all applicable gates:

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm test:demo-workspace
pnpm test:onboarding
node scripts/test-radars-runtime.mjs
pnpm test:prebeta
pnpm test:opportunities
pnpm test:decisions
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Requirements:

- real exit status for each gate;
- `test:demo-workspace`: 0 fail, 0 relevant skip;
- DB-backed Nest-managed demo seed proof included;
- atomic failure rollback/preservation proof included;
- returned entity counts == actual persisted DB inventory.

## Publication and review

1. Branch from verified `main` SHA `aba7cfa8b4f72bb8cae6bbafbb687797065344be`.
2. Use branch `order-130-qa-demo-review-closure-02`.
3. Open a new PR against `main`.
4. Wait for required remote CI to succeed.
5. Request a fresh `@codex review` on the final closure SHA.
6. Fix every P0/P1/P2 in the same closure PR.
7. Require 0 unresolved review threads.
8. Merge only through the protected PR flow with no admin bypass.
9. Verify `main` and post-merge CI.

## DONE criteria

Closure 02 is DONE only when:

- Nest-managed `QaDemoWorkspaceService` can seed/reset using a demo-scoped artifact verifier/model registry;
- production artifact verification remains unchanged;
- failure during reset/reseed preserves the previous complete demo dataset;
- anonymous identity-transition rows are included in `entityCounts`;
- returned counts match actual DB inventory;
- all Order 130 regression invariants remain green;
- `ACTIVE_WORK_ITEM.md` has zero diff;
- all final gates pass;
- remote CI passes;
- fresh final Codex review on the closure head has 0 P0/P1/P2;
- unresolved review threads = 0;
- protected merge completes;
- post-merge `main` contains the closure;
- post-merge CI succeeds when triggered.

## Final handoff

Return a `TRUVO HANDOFF` containing at least:

- Execution Order: 130
- Work Item: QA & Workspace de Demonstração v1 — Review Closure 02
- Result: DONE / PARTIAL
- baseline main SHA
- closure branch SHA
- PR number/URL
- Nest-managed demo seed proof
- demo artifact verifier isolation proof
- atomic reset/reseed failure preservation proof
- entityCounts expected vs DB actual
- DB-backed demo suite result
- all final gates
- remote CI
- fresh Codex review final SHA/result
- unresolved thread count
- merge SHA
- post-merge main SHA / CI
- blockers if PARTIAL

Do not start Order 150 in this execution.
