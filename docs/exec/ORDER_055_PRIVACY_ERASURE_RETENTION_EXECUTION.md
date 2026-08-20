# ORDER 055 — PRIVACY ERASURE & RETENTION EXECUTION

**Priority:** P1  
**Phase:** Foundation  
**Status:** Ready / Build Ready  
**Reuse:** Adapt Order 35 lifecycle foundation

## Goal

Turn Truvo's existing privacy/tombstone primitives into one executable, auditable lifecycle:

`request → authorized execution → per-store result → retry/resume → completed/failed`

Cover subject deletion/anonymization, workspace deletion propagation, export where already supported, retention enforcement, and suppression against accidental reconstruction.

Do not create a second privacy system.

## Preflight

Order 50 is DONE at:

`f14c820750d29a524f260e670e7c56dbe37ea14b`

Before editing:

- inspect `git status`;
- preserve user execution docs;
- use versioned migrations only;
- never use production/staging data for tests.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Inspect first

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Then inspect:
- Order 35 `DataLifecycleService`, controller, contracts and `data_lifecycle_requests`
- `DATA_LIFECYCLE_LINEAGE.md`
- profile tombstone/access-log behavior
- canonical `customers`, identifiers, traits, relationships, outcomes
- Identity v1 + Identity Graph v2 tables/history/conflicts
- ClickHouse events/touchpoints/derived tables
- Redis/cache keys related to identity/customer/context
- Order 40 projection path and replay behavior
- Connector Framework canonical mapping/webhook path
- scheduler/leader-lock jobs
- audit/redaction/security primitives
- Canonical Data Ownership & Versioning docs/specs

Do not redesign unrelated storage ownership.

## 1. One lifecycle request

Extend the existing Order 35 lifecycle model rather than replacing it.

A privacy request must expose durable, workspace-scoped state for:

- request type / target
- authorization/operator context
- overall status
- per-store execution result
- attempts / last error
- resumable checkpoint where needed
- created/started/completed timestamps
- audit correlation

Retries must resume incomplete stores only.

Repeated execution must be idempotent.

Partial failure must be visible — never report `completed` while one required store remains failed/pending.

## 2. Subject erasure propagation

Implement the current approved lineage across applicable stores.

At minimum evaluate and handle:

### Postgres
- canonical customer/context
- identifiers/traits/relationships/outcomes
- legacy profiles
- identity v1 links/merges
- Identity Graph v2 conflicts/merge evidence
- connector/customer-derived references where subject-owned

Apply **delete, anonymize, retain-for-audit, or reconstructable** according to existing lifecycle/data-ownership policy.

Do not erase audit evidence that policy requires to be retained; remove/redact deleted PII from it.

### ClickHouse
Execute deletion/anonymization for subject-linked event/touchpoint/derived data where current policy requires it.

Do not merely mark Postgres deleted while leaving required ClickHouse erasure unexecuted.

Make ClickHouse async mutation state observable/retryable if the existing engine is asynchronous.

### Caches / transient state
Evict identity/customer/context cache material so deleted identity cannot reappear from stale cache.

### Derived / ML artifacts
There may be no production ML artifacts yet. Explicitly enumerate current v4-derived artifacts and:
- erase/anonymize if materialized and subject-addressable;
- or document them as not yet present/reconstructable.

Do not invent an ML store just for this Order.

## 3. Suppression / tombstone against reconstruction

A completed deletion must prevent late/replayed historical data from silently recreating the deleted subject.

Implement a workspace-scoped suppression/tombstone mechanism usable by:

- event → canonical projection
- identity attachment/resolution
- Connector Framework canonical mapping

Requirements:

- replayed historical events may remain valid immutable event records where policy permits;
- they must not silently recreate canonical identity/context for a suppressed subject;
- explicit policy-authorized reactivation must be distinguishable from accidental replay;
- cross-workspace identifiers can never suppress/delete another tenant.

Fail closed when a known deletion suppression applies.

## 4. Workspace deletion

Complete the existing Order 35 workspace deletion orchestration across current MVP stores.

Requirements:

- retry-safe batches
- per-store progress
- auditable
- no cross-workspace effects
- credentials/secrets handled through existing secure deletion path
- safe terminal state

Do not broaden into account/billing product redesign.

## 5. Retention enforcement

Turn retention from configuration/documentation into executable code.

Use existing scheduler/leader-lock infrastructure where practical.

Prove:

- policy selects eligible records deterministically
- jobs are workspace-scoped
- repeated runs are idempotent
- partial failures retry safely
- retention does not cross tenant boundaries
- retention emits audit/operational evidence without leaking PII

Do not invent arbitrary default retention periods if product policy does not define one; require/configure explicit policy and fail safely when absent.

## 6. Export / authorization / audit

Preserve existing export capability and profile access audit.

Every export/delete operation must:

- enforce current workspace/owner/admin authorization
- emit auditable request/operator context
- redact deleted PII from logs/errors/audit metadata
- never return connector secrets

Unauthorized deletion must fail before any store mutation.

## Runtime proof

Use disposable/local infrastructure.

At minimum use disposable Postgres 16.

For ClickHouse erasure behavior, run a disposable/local ClickHouse when the repo's current test/run pattern supports it; do not replace runtime proof with a fake if the required mutation path can be executed locally.

Use local Redis if cache/suppression behavior needs it.

No production/staging data.

## Acceptance

- [ ] one durable lifecycle tracks request → per-store results → completion/failure
- [ ] unauthorized deletion rejected before mutation
- [ ] subject deletion is idempotent/retriable
- [ ] partial store failure is visible and resumable
- [ ] Postgres canonical/profile/identity propagation proven
- [ ] required ClickHouse erasure/anonymization proven at runtime
- [ ] cache/transient identity state is evicted
- [ ] audit evidence retained without deleted PII leakage
- [ ] replayed historical event does not reconstruct suppressed subject
- [ ] identity attach/connector mapping respect suppression
- [ ] same identifier in another workspace is unaffected
- [ ] workspace deletion is retry-safe across current stores
- [ ] retention job executes configured policy
- [ ] retention rerun is idempotent and tenant-isolated
- [ ] export behavior remains authorized/audited
- [ ] existing Order 30/40/45/50 compatibility preserved
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

No required real-store test may be reported PASS if skipped.

## Out of scope

Do not implement:

- new connector/provider adapters
- Radars / propensity / MLOps
- new data warehouse/storage vendor
- broad account/billing deletion redesign
- probabilistic identity
- unrelated data duplication
- public privacy-management UI redesign

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:
- lifecycle state model
- store-by-store policy/actions
- Postgres/ClickHouse/cache evidence
- suppression/replay proof
- workspace deletion proof
- retention execution proof
- authorization/audit/redaction evidence
- migrations
- exact final validation results
- any policy ambiguity or residual risk

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
