# ORDER 140 — Truvo Product Analytics v1 — Review Closure 02

## Execution authority

- **Execution Order:** 140
- **Work Item:** Truvo Product Analytics v1 — Review Closure 02
- **Baseline branch:** `main`
- **Baseline SHA:** `1e4e4ebea492f35bd9c8a9810f5a66fd2d4d53f7`
- **Original PR:** `#6`
- **Original final branch SHA:** `b468307b57f377223b79b8a986e68ef36b1ea8f3`
- **Original merge SHA:** `1e4e4ebea492f35bd9c8a9810f5a66fd2d4d53f7`
- **Post-merge CI:** `38679412609` — SUCCESS
- **Closure branch:** `order-140-product-analytics-review-closure-02`
- **Scope:** one verified post-merge residual finding from the final Codex review
- **Next item blocked:** MVP release cut / milestone validation

## Why this closure exists

PR #6 was merged with green CI and all review threads marked resolved, but the final Codex review on exact head `b468307b57f377223b79b8a986e68ef36b1ea8f3` still contained a P2 finding:

> `opportunities_generated` is emitted even when the materialized batch has zero eligible opportunities.

The thread was resolved without a subsequent fixing commit or a later clean review. Independent inspection of merged `main` confirms the issue remains.

Current code in `apps/api/src/modules/opportunities/opportunities.service.ts` records:

`opportunities_generated`

whenever `auditMetadata` exists and writes metadata `count: result.rows`, regardless of `result.eligible`.

That makes a workspace with only suppressed/ineligible rows count as having generated an opportunity, corrupting `firstOpportunityRate` and the activation funnel.

## Required fix

Change the canonical emission semantics so `opportunities_generated` means at least one eligible, user-visible revenue opportunity was actually materialized.

Requirements:

1. Emit `opportunities_generated` only when `result.eligible > 0`.
2. Use the eligible opportunity count for analytics metadata, not total materialized rows.
3. Preserve the existing audit event behavior unless its semantics explicitly require the same change.
4. Do not change opportunity eligibility rules.
5. Do not change customer EventSchema.
6. Do not broaden Product Analytics scope.
7. Do not introduce dashboard/UI work.

## Direct regression tests

Add deterministic tests proving:

1. A completed materialization with `rows > 0` and `eligible = 0` does **not** record `opportunities_generated`.
2. An all-suppressed/all-ineligible batch does not advance the first-opportunity funnel step.
3. `firstOpportunityRate` does not count that workspace.
4. A materialization with `eligible > 0` records exactly one `opportunities_generated` event.
5. The event metadata `count` equals `eligible`, not total rows.
6. Replay of the same batch remains idempotent.
7. Existing workspace isolation remains intact.

## Focused validation

Run at minimum:

```bash
pnpm test:product-analytics
pnpm test:opportunities
pnpm --filter @truvo/api test
pnpm typecheck
pnpm lint
```

## Final validation

After the last code/test change, run:

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm test:product-analytics
pnpm test:onboarding
pnpm test:app-shell
pnpm test:demo-workspace
pnpm test:prebeta
pnpm test:opportunities
pnpm test:decisions
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

No PASS may be inferred from partial logs.

## Diff hygiene

Before publication:

```bash
git diff --check
git status
git diff origin/main...HEAD
git diff origin/main -- docs/exec/ACTIVE_WORK_ITEM.md
```

Requirements:

- `ACTIVE_WORK_ITEM.md` zero diff.
- Only this closure authority, the opportunity analytics fix, and direct tests.
- No Personalization/Experimentation.
- No unrelated maintenance.
- No broad refactor.
- No artifacts/logs/secrets.

## Publication and review

1. Use the existing closure branch `order-140-product-analytics-review-closure-02`.
2. Do not create another branch.
3. Open a new PR against `main`.
4. Wait for CI on the exact final closure SHA.
5. Request fresh `@codex review`.
6. Wait until the review is actually published for the exact final SHA.
7. Fix every P0/P1/P2 in the same closure PR.
8. Require 0 unresolved review threads.
9. Merge only through protected PR flow.
10. Verify post-merge `main` and CI.
11. Re-check review threads after merge to avoid another review race.

## DONE criteria

Closure 02 is DONE only when:

- zero-eligible batches do not emit `opportunities_generated`;
- positive-eligible batches emit exactly once;
- analytics event `count` equals eligible count;
- first-opportunity funnel and rate remain false for all-ineligible batches;
- product analytics and opportunity regressions pass;
- all final gates pass;
- remote CI succeeds;
- fresh final Codex review on exact closure SHA has 0 P0/P1/P2;
- unresolved threads = 0;
- protected merge completes;
- post-merge main contains the fix;
- post-merge CI succeeds.

## Final handoff

Return `TRUVO HANDOFF` with:

- Execution Order: 140
- Work Item: Truvo Product Analytics v1 — Review Closure 02
- Result: DONE / PARTIAL
- baseline SHA
- final closure SHA
- PR URL
- zero-eligible emission proof
- positive-eligible emission proof
- metadata eligible-count proof
- firstOpportunityRate regression proof
- idempotency proof
- `test:product-analytics`
- `test:opportunities`
- all final gates
- remote CI
- final Codex reviewed SHA/result
- P0/P1/P2 count
- unresolved thread count
- merge SHA
- main SHA
- post-merge CI
- blockers if PARTIAL
- recommended next item: MVP release cut / milestone validation only if DONE

Do not start Personalization or Experimentation in this execution.
