# ORDER 035 — SECURITY, PRIVACY & DATA LIFECYCLE FOUNDATION

**Priority:** P0  
**Phase:** Foundation  
**Status:** Ready / Build Ready  
**Reuse:** Adapt existing security/privacy primitives

## Goal

Make Truvo's customer-data foundation production-safe for tenant isolation, secrets/PII handling, consent boundaries, auditability, deletion/export architecture and recovery.

Reuse existing controls. Do not rebuild security from scratch.

## Preflight

Order 30 is DONE at:

`8b848570ae3df5eb5f4d2f693dcc65985ed19a4a`

Before editing:
- inspect `git status` / `git diff`;
- preserve the user's pre-existing uncommitted execution docs;
- do not mix unrelated work.

Order 30 added canonical `deleted_at`, retention/provenance/workspace boundaries and resumable backfill.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect first:
- workspace authorization/isolation guards
- canonical customer-context tables/services
- identity/profile tombstone flows
- credential/integration secret storage
- existing logging/redaction
- consent/opt-out code
- audit/access-log code
- deletion/export paths
- deployment/backup docs

Read only relevant Security/Privacy/Lifecycle + engineering/validation PRD/spec sections if needed.

## Required

### 1. Tenant boundary

All tenant-owned server reads/writes must require workspace scope.

Add negative integration tests proving workspace A cannot read/mutate workspace B canonical/customer resources.

Use existing authorization patterns and RLS where already applicable. Do not introduce a parallel auth model.

### 2. Secrets + PII

Provide reusable classification/handling helpers for at least:

- email
- phone
- external IDs
- hashes
- credentials/tokens

Requirements:
- persisted connector credentials remain server-only;
- secrets never return to client after persistence;
- logs/errors use existing redaction primitives;
- do not duplicate raw PII into analytics/event stores without an explicit need.

### 3. Consent / opt-out boundary

Represent channel consent/opt-out state through canonical context with source/provenance + timestamp.

Provide a reusable **activation guard contract/service** that fails closed when a known opt-out prohibits an action.

Do not build channel connectors or activation execution here.

### 4. Audit

Ensure critical security/admin changes can emit auditable records for:

- membership / role changes
- API/key lifecycle
- connector create/update/delete
- destructive data operations
- privileged/admin configuration actions

Reuse current audit infrastructure where possible.

### 5. Data lifecycle foundation

Provide minimally executable, workspace-scoped abstractions/workflows for:

- subject export
- subject deletion request
- workspace deletion orchestration
- retention/deletion lineage across current MVP stores
- derived artifacts classified as delete / anonymize / reconstruct

Workflows must be retry-safe and auditable.

**Do not implement the full Order 55 cross-store erasure engine.** Order 35 establishes policy, contracts, orchestration boundaries and minimum executable paths; Order 55 completes broad erasure/retention execution.

### 6. Backup / recovery

Document provider/store responsibility and an initial transactional-store restore procedure.

Add a reproducible validation/runbook step where practical. Never use production data.

## Acceptance

- [ ] workspace A→B negative read/write tests PASS
- [ ] secrets/credentials cannot leak through client responses/logs/errors
- [ ] PII classification/helper exists and is reused
- [ ] known opt-out is fail-closed through activation guard
- [ ] critical admin/config operations have audit path
- [ ] subject export/deletion abstractions are workspace-scoped
- [ ] workspace deletion workflow is retry-safe/auditable
- [ ] lifecycle lineage for current stores is documented
- [ ] backup/restore responsibilities + initial procedure documented
- [ ] Order 30 canonical model/EventSchema compatibility preserved
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

## Out of scope

Do not implement:
- full Order 55 erasure engine
- Identity Graph v2
- Connector Framework/connectors
- Radars/ML/NBA
- new security/observability vendor
- broad auth rewrite
- destructive production operations

Use versioned migrations if schema changes are required.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:
- controls reused vs added
- tenant-negative-test evidence
- PII/secrets/redaction evidence
- consent guard evidence
- audit coverage
- lifecycle/export/delete boundaries
- backup/recovery artifacts
- migrations, if any
- exact final validation results
- deferred Order 55 work

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
