# ORDER 150 — UX & App Shell v1 — Review Closure 02

## Execution authority

- Execution Order: 150
- Work Item: UX & App Shell v1 — Review Closure 02
- Baseline branch: `main`
- Baseline SHA: `8a34e348e24baab557fbe600cd9b37ca311fcd26`
- Original PR: `#4`
- Original final branch SHA: `16fd548a89fcc64e5deb9468bde7666cc0db6f03`
- Original merge SHA: `8a34e348e24baab557fbe600cd9b37ca311fcd26`
- Post-merge CI: `36303729008` — SUCCESS
- Recommended closure branch: `order-150-ux-app-shell-review-closure-02`
- Priority: P0
- Scope: only post-merge residual findings from the final Codex review
- Next item blocked: Order 140 — Truvo Product Analytics v1

## Why this closure exists

PR #4 was merged at `2026-09-27T07:38:34Z`, while the final Codex review on the exact final branch head was submitted at `2026-09-27T07:39:06Z`.

That review opened two new unresolved findings already present in `main`:

1. P1 — workspace provisioning creates a workspace but does not update the session's live workspace list, so selecting the newly created workspace is a guaranteed no-op.
2. P2 — `/app/customers/[id]` treats the canonical customer ID as a `user_id` search instead of loading the canonical profile by ID.

These are objective post-merge residuals, so a new immutable closure authority is justified.

## Residual finding 1 — refresh/adopt session context after workspace provisioning

Current behavior:
- `/app/onboarding` posts to `POST /v1/workspaces`;
- then calls `session.selectWorkspace(created.id)`;
- `selectWorkspace()` only accepts IDs already present in `session.workspaces`;
- for a workspace-less live account, that array is empty.

Required outcome:
- after creation, the authenticated session must refresh or adopt the server-returned workspace;
- `workspaces` must include the created workspace;
- `workspace` must become the created workspace;
- the selected workspace ID must persist;
- provisioning UI must exit;
- repeated submit after successful creation must not create another workspace;
- reload must rehydrate the same workspace;
- refresh/adoption failure must surface truthfully.

Preferred implementation:
- add a session-level `refresh()` / `refreshWorkspaces()` that re-fetches `/v1/users/me`, or
- add an explicit `adoptWorkspace(createdWorkspace)` using only the actual server response and then optionally reconcile with `/v1/users/me`.

Do not invent a live workspace locally.

Required tests:
1. start live with `workspaces=[]`, `workspace=null`;
2. create workspace W;
3. session becomes `workspaces=[..., W]`, `workspace=W`;
4. provisioning becomes false;
5. second submit is not possible after success;
6. reload rehydrates W;
7. failed create/refresh does not silently succeed.

## Residual finding 2 — canonical customer route must load canonical profile directly

The backend exposes:
- `GET /v1/profiles/:canonicalId`
- `GET /v1/profiles/:canonicalId/timeline`
- `GET /v1/profiles/:canonicalId/identities`
- `GET /v1/profiles/:canonicalId/journey`

But `ProfilesView` currently treats `initialCustomerId` from `/app/customers/[id]` as a `user_id` search.

Required outcome:
- route param from `/app/customers/[id]` is the canonical customer ID;
- direct deep link loads `GET /v1/profiles/:canonicalId`;
- search UX remains identifier-based discovery;
- selecting a search result may navigate to its canonical ID;
- 404 renders truthful not-found/empty;
- 403 renders permission;
- API failure renders error;
- workspace switch invalidates old canonical-profile response.

Required tests:
1. `/app/customers/canonical-123` calls `/v1/profiles/canonical-123`;
2. it does not primarily resolve through `type=user_id`;
3. direct reload renders a valid canonical profile;
4. canonical 404/403/error states are truthful;
5. late Workspace A response cannot populate Workspace B route;
6. identifier search still works and resolves to canonical ID.

## Regression requirements

Preserve:
- App Router routes;
- AppShell / PrimaryNav / WorkspaceSwitcher / PageHeader / shared states;
- central capability map;
- live/demo truthfulness;
- onboarding provisioning exemption;
- Radar URL/history sync;
- stale-response protection;
- responsive/mobile navigation;
- accessibility smoke;
- `ACTIVE_WORK_ITEM.md` zero diff;
- no Order 140 implementation.

## Focused validation

```bash
pnpm test:app-shell
pnpm test:onboarding
pnpm typecheck
pnpm lint
```

## Full validation

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm test:app-shell
pnpm test:onboarding
pnpm test:opportunities
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Also run the canonical Radars, Opportunities and route/responsive Playwright smoke tests from Order 150.

## Publication and review

1. Branch from `8a34e348e24baab557fbe600cd9b37ca311fcd26`.
2. Use `order-150-ux-app-shell-review-closure-02`.
3. Add this immutable closure file to `docs/exec/`.
4. Keep `docs/exec/ACTIVE_WORK_ITEM.md` unchanged.
5. Open a new PR against `main`.
6. Wait for CI success.
7. Request fresh `@codex review`.
8. Wait until the review is actually published for the exact final SHA before merging.
9. Fix every P0/P1/P2 in the same closure PR.
10. Require 0 unresolved review threads.
11. Merge through protected PR flow only.
12. Verify post-merge `main` and CI.

## DONE criteria

Closure 02 is DONE only when:
- successful first-workspace provisioning updates authenticated session/workspace context;
- duplicate provisioning after success is prevented;
- reload rehydrates the newly created workspace;
- `/app/customers/[id]` resolves canonical IDs via canonical profile endpoint;
- identifier-based search still works;
- workspace stale-response protections remain correct;
- all Order 150 regression tests remain green;
- `ACTIVE_WORK_ITEM.md` has zero diff;
- all final gates pass;
- remote CI passes;
- fresh final Codex review on exact closure head has 0 P0/P1/P2;
- unresolved review threads = 0;
- protected merge completes;
- post-merge main contains the closure;
- post-merge CI succeeds when triggered.

## Final handoff

Return `TRUVO HANDOFF` with:
- Execution Order: 150
- Work Item: UX & App Shell v1 — Review Closure 02
- Result: DONE / PARTIAL
- baseline main SHA
- closure branch SHA
- closure PR URL
- workspace provisioning session-refresh/adoption proof
- duplicate-provisioning prevention proof
- reload/rehydration proof
- canonical customer route proof
- identifier-search regression proof
- workspace race regression proof
- `test:app-shell`
- onboarding/Radars/Opportunities regressions
- all final gates
- remote CI
- fresh final Codex review SHA/result
- unresolved thread count
- merge SHA
- post-merge main SHA/CI
- blockers if PARTIAL
- recommended next item: Order 140 — Truvo Product Analytics v1 only if DONE

Do not start Order 140 in this execution.
