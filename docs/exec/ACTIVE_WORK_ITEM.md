# ACTIVE WORK ITEM

## Execution Order 20 — Live Data Truthfulness — Remove Silent Mock Fallback

**Priority:** P0  
**Phase:** Foundation  
**Code State:** Partial  
**Reuse Strategy:** Refactor  
**Status:** Ready  
**Readiness:** Build Ready

## Context

Execution Order 10 — Repository Baseline & Green CI is complete.

Verified baseline evidence:

- clean frozen-lockfile install passes;
- lint passes;
- typecheck passes;
- build passes;
- 46/46 tests pass;
- Postgres and ClickHouse setup were validated twice on disposable local containers;
- API, consumer and web start successfully;
- `/health` and `/health/ready` return HTTP 200 with Postgres, ClickHouse, Redis and Kafka healthy.

Do not reopen baseline work unless this task exposes a genuine regression caused by current changes.

A new architecture gate now exists before Order 30:

**Execution Order 27 — Versioned Postgres Migration Framework**

It is not part of this task. Do not implement it now.

## Preflight — clean commit boundary

The Order 10 handoff reports that its changes are still **uncommitted**.

Before changing code for Order 20:

1. inspect `git status` and `git diff`;
2. verify the uncommitted changes correspond to the completed Order 10 baseline work plus the repo context files;
3. create a clean commit for Order 10 if Codex is authorized to commit, otherwise stop and ask the user to commit it;
4. if a remote is configured and push is authorized, allow remote CI to run;
5. start Order 20 from a clean working tree whenever possible.

Do not mix Order 10 stabilization changes and Order 20 truthfulness changes into one undifferentiated diff.

---

# Why this task exists

Truvo's product promise depends on users being able to trust what they see.

The current frontend contains live-data patterns in which an API failure can result in `live.data` being absent/null, while a screen may choose mock data using patterns conceptually similar to:

```ts
const data = live.data ?? MOCK_DATA;
```

That means a broken/unavailable live backend can become a plausible-looking synthetic business dashboard.

This is unacceptable for the Truvo trust model.

> In live mode, synthetic business metrics must never be silently presented as real data because a request failed.

Explicit demo mode may continue using deterministic synthetic data.

---

# Read only this context unless more is required

Always read:

- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

From `/docs/truvo/TRUVO_PRD_v4.4.md`, read only:

- Section 0 — Instructions for Codex
- Section 27 — Live Data Truthfulness
- Section 31 — Critical implementation risks
- Section 34 — Engineering guardrails
- Section 35 — Required validation
- Section 36 — Required Codex completion report

Then inspect the relevant frontend code.

Do not preload the rest of the PRD unless a concrete implementation blocker requires it.

---

# Existing code to inspect first

Start by inspecting, not immediately editing:

- `apps/web/lib/useLive.ts`
- all imports/usages of the live-data abstraction;
- all user-facing screens that contain mock/demo business data;
- repository-wide occurrences of patterns such as:
  - `live.data ??`
  - `?? MOCK`
  - `|| MOCK`
  - fallback demo datasets after live requests;
- existing demo-mode/config/environment mechanisms;
- existing loading/error/empty UI primitives;
- existing request/error observability.

Do not assume the original audit found every occurrence. Perform a repository-wide search.

---

# Required product-state model

Every live business-data surface must distinguish the following states where applicable:

1. **loading**
2. **success with data**
3. **success with legitimate empty data**
4. **error / unavailable backend**
5. **stale or partial data**, only when explicitly supported
6. **demo mode**
7. **permission/auth failure**, where relevant

An error must never collapse into the same state as “no live data yet”.

Demo must never be inferred merely because live data is unavailable.

---

# Required invariant

## Demo mode

Synthetic/mock data is allowed only when the application is explicitly operating in a demo/development mode that intends to show synthetic data.

Demo data should be clearly distinguishable in code from live response data.

## Live mode

If a live request fails:

- do not render mock business metrics;
- do not render stale data from another workspace as if current;
- expose a real error/degraded state;
- preserve enough error information for observability without leaking sensitive payloads.

If a live request succeeds with an empty dataset:

- show the legitimate empty state;
- do not switch to demo/mock data.

---

# Implementation direction

Prefer a small, reusable state contract over one-off patches in many screens.

The live-data abstraction should make it difficult to accidentally confuse:

```text
loading
success(data)
success(empty)
error
demo
```

Possible implementation approaches are acceptable if they preserve existing architecture, for example:

- return an explicit state/discriminated union from the live-data hook;
- add explicit `isDemo`, `isLoading`, `error`, `data`, `isEmpty` semantics;
- introduce shared screen-state components/conventions;
- centralize demo-data selection behind explicit demo-mode logic.

Do not introduce a second frontend data-fetching architecture unless existing code cannot be safely adapted.

---

# Workspace isolation requirement

When changing workspace or live/demo context:

- previously loaded data from another workspace must not flash or persist as the new workspace's data;
- an error on workspace B must not cause workspace A's previous data to appear;
- demo data must not become the fallback for a live workspace.

Add regression coverage if the current hook/state model makes this scenario possible.

---

# Observability

Live request failures should be observable through the repository's existing logging/error-reporting conventions where practical.

Requirements:

- do not log secrets/tokens;
- do not log sensitive response payloads unnecessarily;
- retain useful route/status/error context;
- avoid adding a new observability vendor or platform in this task.

Full Observability Foundation is a later work item.

---

# Tests required

At minimum, add/adjust automated regression tests proving:

- [ ] live request success renders real live values;
- [ ] live request failure renders an error/degraded state;
- [ ] live request failure never renders mock business values;
- [ ] successful empty response renders an empty state;
- [ ] explicit demo mode still renders deterministic demo data;
- [ ] switching workspace/mode cannot leak prior workspace data;
- [ ] repository search does not leave unsafe silent mock fallback patterns on live business-data surfaces.

Test the shared abstraction directly where useful and add representative screen-level tests where needed to prove the real user-visible invariant.

Do not create brittle snapshot-only tests that fail to prove the data source being rendered.

---

# Scope constraints

Do not implement in this work item:

- Canonical Customer Context;
- new Postgres schemas/migrations;
- Versioned Postgres Migration Framework;
- Identity Graph v2;
- Connector Framework;
- Radars;
- propensity modeling;
- Revenue Opportunities;
- broad visual redesign;
- brand redesign;
- a new observability stack.

If you find a real issue in one of those areas, report it in the handoff instead of expanding scope.

---

# Acceptance Criteria

All of the following must be demonstrably satisfied:

- [ ] Demo mode may intentionally use synthetic data.
- [ ] In live mode, API failure/unavailable data never falls back to mock business metrics.
- [ ] Live screens expose standardized loading/error/empty states.
- [ ] Stale/degraded data is explicit when supported and never masquerades as current live data.
- [ ] Fetch failures are observable using existing platform conventions where practical.
- [ ] Workspace/mode switches cannot leak previous workspace data.
- [ ] Regression tests enforce the no-silent-mock invariant.
- [ ] Existing intentional demo experience remains available.
- [ ] Lint passes.
- [ ] Typecheck passes.
- [ ] Relevant tests pass.
- [ ] Build passes.
- [ ] No unrelated Truvo 4.x work is included.

---

# Validation

Run at minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also run any focused tests added for the live-data state model.

Perform a repository search for mock fallback patterns before and after the changes and report the results in the handoff.

If the full test suite cannot run for an environment reason, do not call it passing. Report exactly what was skipped and why.

---

# Definition of Done

No production/live Truvo screen can silently substitute synthetic business data after a live API failure.

The repository contains reusable state handling and regression tests that make this invariant enforceable rather than relying only on developer discipline.

Intentional demo mode continues working.

---

# Required completion report

At the end, use `/docs/exec/HANDOFF_TEMPLATE.md` exactly.

Important evidence to include:

- live-data abstraction changed;
- screens/components changed;
- repository search results for unsafe mock fallback patterns;
- tests proving live failure does not render mock values;
- workspace-switch test/result;
- exact lint/typecheck/test/build commands and results;
- any remaining screen intentionally using mock data and why it is safe;
- any newly discovered product/architecture risk.

Do not start Execution Order 25 or 27 automatically.

End the report with:

`TRUVO_CODEX_HANDOFF_END`
