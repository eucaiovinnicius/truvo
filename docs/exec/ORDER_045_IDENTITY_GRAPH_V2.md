# ORDER 045 — IDENTITY GRAPH V2

**Priority:** P0  
**Phase:** Foundation  
**Status:** Ready / Build Ready  
**Reuse:** Refactor and preserve Identity v1

## Goal

Evolve the existing Truvo identity graph into deterministic, multi-source Identity Graph v2 with:

- collision-safe namespaced identifiers
- explicit conflict handling
- auditable merge evidence/history
- reversible merge structures
- preserved retroactive stitching
- strict workspace isolation

Do **not** rebuild identity from scratch.

## Preflight

Order 40 is DONE (handoff commit prefix `8751823`).

Before editing:

- run `git status` and `git log -1`;
- preserve user execution docs;
- inspect the actual current identity schema/service before designing migrations;
- use versioned Postgres migrations only.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect first:
- `identity_links`
- `identity_merges`
- current unique indexes/constraints
- `IdentityService`
- consumer retro-stitching path
- Redis/ClickHouse identity infra
- Order 30 `customers` / `customer_identifiers`
- Order 40 identify → canonical-context bridge
- workspace isolation/security patterns
- versioned migration runner

Read only relevant Identity Graph / engineering / validation specs if needed.

## Critical migration rule

Current v1 uniqueness is known to be too coarse: `workspace_id + identifier` omits identifier type/source semantics.

Before changing constraints:

1. inspect existing data shape and current uniqueness behavior;
2. define the deterministic v2 namespace/type/provider representation;
3. provide a collision/preflight query or controlled migration check;
4. preserve all existing identity links/merge history;
5. fail closed if existing rows cannot be migrated safely.

No silent reassignment or destructive identity rewrite.

## Supported deterministic identifiers

Support existing/approved deterministic identifiers such as:

- Truvo `user_id`
- `anonymous_id`
- approved hashed email / phone
- explicitly resolved click/session links
- order/customer IDs
- provider-scoped external IDs such as Shopify customer, HubSpot contact, Klaviyo profile, Stripe customer

Provider IDs must be namespaced. The same external string from different providers must not collide.

No probabilistic/fuzzy identity matching.

## Required service behavior

Provide/refactor reusable identity operations equivalent to:

- `resolveOrCreateCustomer`
- `attachIdentifier`
- `mergeCustomers`
- `recordConflict`
- `getIdentityGraph`
- `enqueueRetroactiveStitch`

Connectors and downstream code must be able to rely on these services instead of implementing identity matching independently.

Preserve existing public `identify()` compatibility where possible through adapters.

## Merge policy

Use deterministic evidence only.

Strong authenticated/customer identifiers and approved hashed contact identifiers may support deterministic merge.

Anonymous/session identifiers are weaker evidence.

Rules:

- one active identifier cannot resolve to two canonical customers in the same workspace;
- strong identifiers that disagree must create an explicit conflict and **stop automatic merge**;
- no cross-workspace merge;
- repeated merge/replay is idempotent;
- provider merge/delete signals do not silently erase Truvo history.

Every merge records:

- workspace
- source/target customer
- identifiers/evidence used
- reason
- source/provider
- timestamp
- actor/system process
- operation/version metadata needed for audit/rebuild

## Reversibility

Data structures must make merge reversal possible.

Provide an internal/admin-safe **unmerge or rebuild mechanism** based on merge history/evidence.

Public UI is out of scope.

Prove that reversal does not require reconstructing identity from undocumented side effects.

Do not rewrite immutable raw event payloads.

## Conflict model

Persist/represent identity conflicts explicitly and observably.

At minimum capture:

- workspace
- conflicting strong identifiers/customers
- reason/evidence
- detected timestamp
- resolution status

Ambiguous cases remain separate until explicitly resolved.

Do not silently choose a winner.

## Retroactive stitching

Preserve current anonymous → identified historical stitching.

Requirements:

- resumable/retry-safe
- idempotent
- tenant-isolated
- does not mutate raw source events
- materialized/customer linkage converges after replay

Reuse existing queue/Redis/ClickHouse path rather than create a parallel system.

## Runtime validation

Use disposable/local infrastructure where needed.

For Postgres schema/migration proof, prefer disposable Postgres 16 via Docker.

If Redis is needed for retro-stitch runtime tests, use disposable/local Redis; do not depend on unavailable external dev infrastructure.

No staging/production data.

## Acceptance

- [ ] existing `identity_links` / `identity_merges` preserved
- [ ] migration from v1 data is non-destructive
- [ ] uniqueness is collision-safe by workspace + identifier namespace/type + value
- [ ] same external value across providers/workspaces cannot collide
- [ ] existing `identify()` contract remains compatible
- [ ] deterministic cross-device anonymous → identified flow PASS
- [ ] Shopify + Klaviyo same approved hashed identity resolves consistently
- [ ] conflicting strong identifiers remain separate + conflict is recorded
- [ ] repeated webhook/attach/merge is idempotent
- [ ] merge history/evidence is auditable
- [ ] unmerge/rebuild mechanism is runtime-tested
- [ ] tenant isolation negative tests PASS
- [ ] retroactive stitch replay/idempotency PASS
- [ ] raw historical event payloads remain immutable
- [ ] canonical customer bridge remains compatible
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No relevant real-DB test may be reported as PASS if it was skipped.

## Out of scope

Do not implement:

- fuzzy/probabilistic identity matching
- Connector Framework or provider connectors
- provider-specific business sync
- Radars / ML / NBA
- public conflict-resolution UI
- broad EventSchema redesign
- rewrite of ClickHouse event history

Expose clean provider-neutral identity contracts for later connectors.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- v1 assets preserved
- migration/collision-preflight evidence
- identifier namespace model
- conflict evidence
- merge/replay evidence
- reversibility/unmerge proof
- tenant isolation
- retro-stitch idempotency
- exact final validation results
- any new architecture decision/risk

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
