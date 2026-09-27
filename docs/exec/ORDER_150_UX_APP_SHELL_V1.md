# ORDER 150 — UX & App Shell v1

## Execution authority

- **Execution Order:** 150
- **Work Item:** UX & App Shell v1
- **Implementation Spec:** SPEC-17 — UX & App Shell v1 — Implementation Spec
- **Baseline branch:** `main`
- **Baseline SHA:** `9febe52dcb79f7a681405ca2ca83d94829e37394`
- **Recommended branch:** `order-150-ux-app-shell-v1`
- **Priority:** P0
- **Code State:** Partial
- **Reuse Strategy:** Refactor
- **Dependency status:** Order 130 DONE and post-merge CI green
- **Next item blocked:** Order 140

## Mission

Refactor the current client-state SPA shell into a reusable, route-based MVP application shell without redesigning the brand or rebuilding existing product views.

The release-critical product must expose only real/ready MVP navigation, provide truthful shared screen states, preserve workspace isolation, and make the critical journeys coherent across desktop and mobile.

## Current repository reality to reuse

The current frontend already contains useful product UI and state that must be adapted rather than replaced:

- `apps/web/app/page.tsx` mounts the client-only SPA.
- `apps/web/appui/App.tsx` currently owns session gating, workspace selection, view routing and most shell orchestration.
- `apps/web/appui/components/Sidebar.tsx` exposes many current and future modules.
- `apps/web/appui/components/TopBar.tsx` provides top-level controls.
- Existing critical product views include `OnboardingFlow.tsx`, `IntegrationsView.tsx`, `RadarsView.tsx`, `RevenueOpportunitiesView.tsx`, `ProfilesView.tsx`, and `SettingsView.tsx`.
- Existing truthful live-data primitives include `apps/web/lib/live-state.ts`, `live-ui.tsx`, `live.ts`, and `session.tsx`.
- Existing E2E includes onboarding, radars and opportunities.

Do not duplicate API/backend logic or replace established product views with throwaway mock screens.

## Phase A — Audit and route map

1. Confirm clean baseline at `9febe52dcb79f7a681405ca2ca83d94829e37394`.
2. Create branch `order-150-ux-app-shell-v1`.
3. Audit all `ViewState` usages, shell components, session/workspace semantics, current live/demo branching and current navigation entries.
4. Classify each existing screen as MVP route now, reused component behind an MVP route, future/flagged and hidden, or legacy/demo-only.
5. Record the reuse/route map in the final handoff.

Do not stop after the audit.

## Phase B — Real App Router foundation

Implement the SPEC-17 routes using the Next.js App Router:

- `/app`
- `/app/onboarding`
- `/app/integrations`
- `/app/radars`
- `/app/radars/[id]`
- `/app/opportunities`
- `/app/customers/[id]`
- `/app/settings`

Requirements:

- `/` may remain the login/demo entrypoint, but successful authenticated/demo entry must lead into the route-based app shell.
- Use route navigation (`next/navigation` / `Link`) for MVP navigation instead of the central `currentView` state router.
- Do not broadly rewrite large existing views merely to make them route-aware; wrap/adapt them.
- Preserve existing demo and live mode semantics.
- Direct navigation/reload on an `/app/...` route must work.
- Unknown/unavailable app routes must fail truthfully.

## Phase C — Reusable shell primitives

Create/adapt:

- `AppShell`
- `WorkspaceSwitcher`
- `PrimaryNav`
- `PageHeader`
- `DataState`
- `EmptyState`
- `ErrorState`
- `DegradedState`
- `PermissionState`
- `Loading` / `Skeleton`
- `ConfirmationDialog`

Reuse existing `Sidebar`, `TopBar`, `live-ui`, session and semantic CSS where practical. Avoid one-off page-specific copies of loading/error/empty patterns. Do not create a new visual identity.

## Phase D — MVP navigation and feature visibility

Default MVP navigation must expose coherent, real areas:

- Overview
- Opportunities
- Radars
- Customers
- Data / Integrations
- Settings

`Measure` may appear only if there is a truthful MVP-ready surface already supported by the current implementation.

Future/noncritical modules such as broad Funnels, Funnel Builder, Creative Analytics, AI Journeys, Reports, Billing and incomplete prototype areas must be hidden unless enabled through one central feature flag/capability map.

Hidden routes must not remain clickable dead destinations. UI hiding is not authorization.

## Phase E — Session and workspace guard

Workspace context is mandatory for live tenant routes.

Provide reusable handling for:

- session hydrating;
- unauthenticated;
- authenticated with workspace;
- authenticated with no accessible workspace;
- demo mode.

Prove:

- no stale workspace flash;
- switching workspace keys/invalidates tenant-scoped UI state;
- an in-flight Workspace A response cannot overwrite Workspace B;
- live workspace list is not invented locally;
- demo remains explicitly demo-only;
- permission/auth failure never turns into demo/mock data.

Backend authorization remains authoritative.

## Phase F — Critical route adapters

Adapt the existing product views:

### `/app`
Coherent MVP home/overview using real existing data. Do not invent metrics.

### `/app/onboarding`
Reuse `OnboardingFlow`; preserve Order 120 durable behavior.

### `/app/integrations`
Reuse current integrations UI and truthful connector states.

### `/app/radars`
Reuse `RadarsView`.

### `/app/radars/[id]`
Route-addressable Radar detail using existing APIs/components.

### `/app/opportunities`
Reuse `RevenueOpportunitiesView`; preserve activation behavior and E2E.

### `/app/customers/[id]`
Adapt existing profile/customer context. Prefer narrow truthful data over mock analytics.

### `/app/settings`
Reuse functional workspace/user settings; hide unavailable controls.

## Phase G — Truthful shared screen states

Critical routes must consistently support, where applicable:

- loading;
- success with data;
- legitimate empty;
- error/unavailable;
- degraded/stale when explicitly supported;
- permission/auth failure;
- feature unavailable;
- demo.

Use the existing live-truthfulness contract.

Prove live API error/empty/permission never falls back to demo business data and workspace switching cannot expose prior tenant values.

## Phase H — Responsive and accessibility

Desktop remains primary for dense data, but critical routes must remain usable on mobile.

At minimum:

- usable mobile navigation;
- accessible workspace switcher;
- reachable page actions;
- tables scroll/adapt without hiding critical actions;
- dialogs usable;
- no shell-caused mandatory horizontal page overflow.

Accessibility proof must include semantic navigation, keyboard reachability, visible focus, accessible icon labels, active-route semantics, accessible status/error feedback and keyboard-operable mobile nav.

## Phase I — Automated tests

Directly prove:

- all SPEC-17 routes are addressable;
- active navigation follows pathname;
- direct reload works;
- future disabled modules are hidden/guarded;
- unauthenticated handling;
- live workspace guard;
- no-workspace state;
- workspace switch changes tenant context;
- late Workspace A response cannot overwrite Workspace B;
- loading/empty/error/degraded/permission/feature-unavailable/demo states;
- feature flag enabled/disabled behavior;
- desktop smoke;
- mobile viewport smoke;
- keyboard navigation smoke.

Preserve and rerun existing onboarding, Radars and Opportunities E2Es.

## Phase J — Regression command

Add `pnpm test:app-shell` if no existing canonical command already provides equivalent proof.

It should run fast deterministic Order 150 shell tests. Integrate with pre-beta/release only if it does not duplicate an existing gate. Do not weaken Order 130/onboarding gates.

## Phase K — Final validation

After the final code/test change run:

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

Also run relevant Playwright route/responsive smoke plus existing Radars/Opportunities E2Es using the repo's canonical setup.

If `test:app-shell` is intentionally unnecessary because an existing canonical command fully covers the proof, document that exact decision. No PASS may be inferred from partial logs.

## Phase L — Diff hygiene

Before publication:

```bash
git diff --check
git status
git diff origin/main...HEAD
git diff origin/main -- docs/exec/ACTIVE_WORK_ITEM.md
```

Require `ACTIVE_WORK_ITEM.md` zero diff.

Do not include Order 140, Personalization/Experimentation, brand redesign, unrelated backend refactors, artifacts or secrets.

## Phase M — Publication, review and merge

1. Commit only Order 150 on `order-150-ux-app-shell-v1`.
2. Push normally; never force-push.
3. Open one PR against `main`.
4. Wait for required CI success on the final SHA.
5. Request fresh `@codex review`.
6. **Wait for the review to actually finish before merging.**
7. Fix every P0/P1/P2 in the same PR.
8. After each fix, rerun affected gates, push, wait for CI and request a fresh review on the new SHA.
9. Require 0 unresolved review threads.
10. Merge through protected PR flow only.
11. Verify `main` and post-merge CI.

Do not repeat the Order 130 race: a review request or 👀 reaction is not a completed final review.

## DONE criteria

Order 150 is DONE only when:

- SPEC-17 routes are real and directly addressable;
- reusable AppShell and screen-state primitives exist;
- critical MVP navigation is coherent;
- future modules are centrally feature-flagged/hidden;
- live/demo truthfulness is preserved;
- workspace switching cannot leak stale tenant data;
- route/session/workspace guards are proven;
- responsive and accessibility smoke pass;
- onboarding/Radars/Opportunities critical flows remain green;
- all final gates pass;
- remote CI passes;
- fresh final Codex review on exact final SHA has 0 P0/P1/P2;
- unresolved review threads = 0;
- protected merge completes;
- main contains Order 150;
- post-merge CI succeeds when triggered.

## Explicit non-goals

Do not redesign the brand, implement Order 140, implement Personalization/Experimentation, complete every historical prototype screen, replace working backend APIs, move authorization to frontend-only checks, use demo as live fallback, or create a second frontend architecture beside Next.js App Router.

## Final handoff

Return `TRUVO HANDOFF` with:

- Execution Order: 150
- Work Item: UX & App Shell v1
- Result: DONE / PARTIAL
- baseline SHA
- final branch SHA
- PR URL
- route map
- reused/refactored components
- feature flag map
- session/workspace guard proof
- shared state primitive proof
- responsive/accessibility proof
- existing E2E regression results
- all final gates
- remote CI
- fresh final Codex review SHA/result
- unresolved thread count
- merge SHA
- main SHA
- post-merge CI
- blockers if PARTIAL
- recommended next item: Order 140 only if DONE

Do not start Order 140 in this execution.
