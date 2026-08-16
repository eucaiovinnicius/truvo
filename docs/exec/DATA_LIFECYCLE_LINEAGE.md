# Data Lifecycle Lineage (Order 035)

Source of truth (code, tested): `apps/api/src/modules/data-lifecycle/data-lifecycle.contracts.ts` → `DATA_LIFECYCLE_LINEAGE`. This document is the human-readable mirror for the handoff/Notion — keep both in sync when the classification changes.

## What Order 035 actually executes

`DataLifecycleService` provides three workspace-scoped, retry-safe, auditable workflows:

- **Subject export** (`requestSubjectExport`) — assembles the canonical Postgres context (`CustomerContextService.getContext`) for one customer. ClickHouse behavioral data is **referenced**, not fetched (see `behavior_references` in `CustomerContext`). Logged twice: `audit_log` (security/admin trail) and `profile_access_log` (existing M15 LGPD access trail, action `export` — reused, not duplicated).
- **Subject deletion** (`requestSubjectDeletion`) — tombstones (`deleted_at = now()`) one customer's row plus its `customer_identifiers`/`customer_traits`/`customer_relationships`. Idempotent: a repeated call finds nothing left with `deleted_at IS NULL` and processes zero rows.
- **Workspace deletion** (`requestWorkspaceDeletion`) — tombstones **all** customer-context rows for a workspace (including `outcome_definitions`, which is workspace-level, not subject-level) in bounded batches (500 rows/batch) per table, independently retry-safe: any table can resume from wherever it left off without depending on another table's progress.

None of this performs a **physical** purge, and none of it touches ClickHouse. That is intentional — Order 035 establishes the policy, contracts, and orchestration boundary; **Order 55 is the cross-store erasure engine** that performs the final physical/anonymizing pass documented below.

## Store-by-store classification

| Store | What it holds | Classification | Order 035 executes it? | Notes |
|---|---|---|---|---|
| `postgres.customers` / `customer_identifiers` / `customer_traits` / `customer_relationships` | Canonical customer context (Order 30) | **delete** | ✅ Yes | Tombstoned via `deleted_at`; physical purge is an Order 55 retention sweep. |
| `postgres.outcome_definitions` | Workspace-level outcome config | **delete** | ✅ Yes | Only tombstoned on `workspace_deletion` (it is not a subject's data). |
| `postgres.identity_links` / `identity_merges` | Legacy v3.2 identity graph (M8) | **anonymize** | ❌ No | `customers.legacy_canonical_id` references it; Order 55 must resolve and apply the same retention decision to the legacy graph. |
| `postgres.user_profiles` | M15 profile projection | **reconstruct** | ❌ No | A derived cache — regenerates automatically from source once upstream is purged. No direct action needed. |
| `postgres.profile_access_log` | M15 LGPD access trail | **anonymize** | ❌ No | It is itself an audit record; Order 55 decides its own retention policy separately from the subject it describes. |
| `clickhouse.events` | Raw event stream (M2), hashed/pseudonymous identifiers per row | **anonymize** | ❌ No | Referenced (not fetched/erased) via `behavior_references`. Row-level purge/anonymization is the Order 55 engine. |
| `clickhouse.touchpoints` | Attribution touchpoints (M7/M8), derived from events | **anonymize** | ❌ No | Same boundary as `events`. |
| `clickhouse.*_daily` / materialized views | Aggregated/materialized projections (funnels, attribution, reconciliation, creatives) | **reconstruct** | ❌ No | Derived — regenerate from source events after upstream purge; no direct per-subject action. |
| `postgres.integration_out_logs` / `webhook_logs` | Outbound/inbound integration delivery logs (M4/M9) | **anonymize** | ❌ No | Retained for operational audit; PII fields (if any) require Order 55 review. |

## Backup/recovery boundary

See `docs/operations/environments-and-release.md` → "Backup and recovery" for the provider/store responsibility matrix and the initial Postgres restore procedure required by Order 035 §6.
