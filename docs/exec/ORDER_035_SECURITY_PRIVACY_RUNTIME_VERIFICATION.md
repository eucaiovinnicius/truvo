# ORDER 035 — SECURITY / PRIVACY RUNTIME VERIFICATION

**Execution Order:** 35  
**Goal:** close the remaining live-Postgres acceptance gate only.

## Current state

Order 35 implementation is committed at:

`ba85b03b767083573932311f10693ea0bc4de691`

Already PASS:

- frozen install
- migration:validate
- lint
- typecheck
- test suite with 29 PASS + 3 honest SKIP
- build
- DI/API boot
- audit / PII / consent / lifecycle unit coverage

Do not redesign or reimplement Order 35 unless runtime proof exposes a real defect.

Ignore stale `docs/exec/ACTIVE_WORK_ITEM.md`. This named Order file is authoritative for this execution.

## Read

- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`
- current Order 35 diff/commit
- `packages/db/migrations/0002_slow_kinsey_walden.sql`
- the two real-Postgres tenant/lifecycle test files
- Order 27 migration runner conventions

## 1. Use disposable Postgres

Do **not** wait for or troubleshoot the unavailable Supabase dev project.

Start an isolated local/disposable Postgres 16 with Docker, using a non-production port/database.

Point `DATABASE_URL` only at that disposable instance.

Never use staging/production data or credentials.

## 2. Apply migrations

Using the normal versioned runner:

- [ ] migrate clean DB from zero through `0002`
- [ ] confirm migration history contains baseline + Order 30 + Order 35 migrations
- [ ] second migration run is safe/no-op
- [ ] `audit_log` and `data_lifecycle_requests` exist with expected indexes/enums

If the migration itself fails, fix only the in-scope defect and rerun.

## 3. Execute the previously skipped proofs

Run the real-Postgres tests with the disposable `DATABASE_URL`.

Required:

- [ ] **zero SKIP** for the 3 previously skipped Postgres cases
- [ ] workspace A cannot read B customer/context resources
- [ ] workspace A cannot mutate B resources
- [ ] workspace deletion batching/retry/idempotency passes against real Postgres
- [ ] audit/lifecycle rows remain workspace-scoped

Do not accept fake-DB evidence as closure for these items.

## 4. Final regression gate

After any necessary fix, run sequentially:

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Every command must PASS.

The final test report must clearly show the previously skipped Postgres tests executed successfully.

## Scope

Do not:
- implement Order 40
- implement full Order 55 erasure
- unify hard workspace delete with lifecycle orchestration unless a failing acceptance test requires it
- change consent product policy
- touch production/staging
- update or rely on `ACTIVE_WORK_ITEM.md`

## Definition of Done

Return `DONE` only if migration `0002` applies on real disposable Postgres, all 3 previously skipped tests execute and PASS, tenant isolation and lifecycle retry behavior are proven at runtime, and the full final repo gate is green.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include exact Docker/Postgres commands, migration evidence, test counts with **0 relevant SKIP**, and final repo results.

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
