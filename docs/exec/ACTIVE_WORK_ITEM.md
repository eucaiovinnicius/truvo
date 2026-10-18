# ACTIVE WORK ITEM

## Execution Order 143 — Controlled Beta Rollout & Hosted Environment Go-Live

**Priority:** P0
**Phase:** Controlled Beta
**Code State:** Authorized release candidate
**Status:** Blocked on authenticated provider access
**Readiness:** NO-GO

## Authority

This file remains the repository-local execution authority defined by `AGENTS.md`.
Execution Order 142 is complete. The detailed EO 143 execution prompt is the scope
authority for this work item; prior execution history is not rewritten here.

## Baseline

- Canonical main SHA: `692fc3b2c23324f62d581a660446a786bf602644`
- Previous order: EO 142 — DONE
- Authorized release candidate: `v0.1.0-rc.1`
- Release candidate SHA: `692fc3b2c23324f62d581a660446a786bf602644`

## Objective

Turn the validated release candidate into an operationally safe hosted staging and
controlled beta environment. Inventory the real providers, prove isolation,
configuration, backups and restore, migrations, health, critical flows, access
control, observability, and operational rollback before enabling a beta cohort.

## Scope constraints

- Operational rollout and beta go-live blocker fixes only.
- Hosted staging and controlled beta are authorized; unrestricted public/GA launch
  is not authorized.
- No Personalization, Experimentation, new models, new algorithms, new product
  features, redesign, broad refactor, or opportunistic dependency upgrades.
- Never fabricate provider evidence, expose credentials, weaken safety gates, or
  deploy when a hard go-live gate is unresolved.

## Completion gates

- real provider inventory and secure environment contract are verified;
- hosted staging exists and is isolated from the beta/production data plane;
- backup tier and safe Postgres restore proof are verified;
- migrations, domains/TLS, CORS, production auth, release identity, health,
  readiness, workers, critical flows, tenant isolation, and live/demo truthfulness
  pass in the hosted environment;
- beta access is restricted, logs are safe, and hosted rollback is proven;
- formal decision is GO before any controlled beta cohort is enabled;
- any repository change has clean review, protected merge, and green post-merge CI;
- final handoff follows the EO 143 required format and ends with
  `TRUVO_CODEX_HANDOFF_END`.

Do not start the next execution order automatically.
