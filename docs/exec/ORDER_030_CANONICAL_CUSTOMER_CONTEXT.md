# ACTIVE WORK ITEM

## Order 30 — Canonical Customer Context Model

**Priority:** P0  
**Status:** Ready / Build Ready  
**Reuse:** Adapt EventSchema, profiles and identity v1

## Goal

Add Truvo 4.x canonical customer context without replacing the existing event pipeline.

Primitives:

**Customer + Identifier + Trait/State + Relationship + Outcome Definition**

Events remain events. State must not be fabricated as events.

## Preflight

Order 27 is DONE at `eb612c186a9652c0a79f022dd2af0786a6963990`.

Use the versioned Postgres migration workflow for every schema change. Do not use `drizzle-kit push` as the implementation/release path.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect:
- `packages/event-schema/**`
- Postgres schemas/migrations in `packages/db/**`
- existing profiles / `user_profiles`
- identity module/service + identifier storage
- consumer identity stitching
- workspace isolation patterns

Read only relevant Canonical Context / engineering / validation PRD sections if needed.

## Required model

Additive, workspace-scoped entities/contracts equivalent to:

- `customers`
- `customer_identifiers`
- `customer_traits`
- `customer_relationships`
- `outcome_definitions`

Rules:

- stable internal IDs
- workspace in every lookup/unique boundary
- source/provenance + timestamps
- retention/soft-delete semantics where applicable
- identifiers namespaced by type/provider
- traits preserve typed value, source, `observed_at`, freshness/provenance
- stale trait updates never overwrite newer state
- no fuzzy identity merge
- provider fields do not leak into canonical contracts without namespacing

Postgres owns canonical identity/state/configuration. ClickHouse remains high-volume event history.

## Compatibility / service

Preserve EventSchema unchanged.

Provide typed internal contracts plus reusable `CustomerContextService` returning customer, identifiers, current traits/state, relationships and behavior/context references.

Add only the minimum bridge from existing Truvo-native profile/identity/event data.

Do not implement full Identity v2 conflict/reversibility logic.

## Backfill

Provide a workspace-scoped backfill for existing known Truvo profile/identity data that is:

- idempotent
- resumable/checkpointed
- retry-safe
- tenant-isolated

No production data required for validation.

## Migration

Create the next **versioned additive** Postgres migration using Order 27 tooling.

Do not replace/drop existing v3.2 tables.

## Acceptance

- [ ] canonical entities + typed contracts exist
- [ ] migration applies cleanly
- [ ] EventSchema remains compatible unchanged
- [ ] all canonical lookups/upserts are workspace-isolated
- [ ] same external value across workspaces/providers cannot collide
- [ ] stale trait update cannot overwrite newer state
- [ ] typed trait behavior is deterministic
- [ ] anonymous → identified customer resolves using existing safe identity behavior
- [ ] backfill is idempotent/resumable
- [ ] canonical contracts contain no unnamespaced provider leakage
- [ ] existing event pipeline remains compatible
- [ ] `pnpm migration:validate` PASS
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

## Out of scope

Do not implement:
- full Identity v2
- Connector Framework/connectors
- Radars/ML/propensity
- Revenue Opportunities/NBA
- moving event history from ClickHouse
- broad API/UI redesign

Expose interfaces for future subsystems instead of implementing them.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include migration, contracts/entities, reuse, EventSchema compatibility, workspace isolation, trait precedence, backfill/retry evidence and exact final validation results.

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
