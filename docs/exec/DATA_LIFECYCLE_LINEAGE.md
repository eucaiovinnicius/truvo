# Data Lifecycle Lineage (Order 035 → Order 055)

Source of truth (code, tested): `apps/api/src/modules/data-lifecycle/data-lifecycle.contracts.ts` → `DATA_LIFECYCLE_LINEAGE`. This document is the human-readable mirror for the handoff/Notion — keep both in sync when the classification changes.

## What Order 055 executes (current state)

`DataLifecycleService` provides four workspace-scoped, retry-safe, auditable workflows, each tracked per-store in `data_lifecycle_store_results`:

- **Subject export** (`requestSubjectExport`) — unchanged from Order 035: assembles the canonical Postgres context, references (not fetches) ClickHouse behavior, logs to `audit_log` + `profile_access_log`.
- **Subject deletion** (`requestSubjectDeletion` / `retrySubjectDeletion`) — runs every handler in `erasure/subject-erasure.registry.ts` (`customer_context`, `identity_v1`, `identity_graph_v2_evidence`, `clickhouse_events_touchpoints`), tracks each independently, reports `completed` only when ALL are `completed`. On full success, suppresses every identifier the subject was known under (`identity_suppressions`) so a replayed historical event cannot silently recreate them. A retry re-runs only the stores not yet `completed`.
- **Workspace deletion** (`requestWorkspaceDeletion`) — the Order 035 batch tombstone (now also covering `customer_outcomes`) plus hard-deletes of every workspace-scoped store Orders 40/45/50 added afterward: `identity_links`/`identity_merges`, `identity_conflicts`/`identity_merge_events`, `connector_connections` (cascades to checkpoints/sync runs/destination writes), `integrations`/`integration_out_configs` (destroys credentials), and ClickHouse `events`/`touchpoints`.
- **Retention enforcement** (`RetentionEnforcementService`, wired into the existing leader-lock scheduler) — physically purges rows tombstoned past a workspace's configured `tombstone_purge_after_days` (`data_retention_settings`). No implicit default: a workspace with no row/no configured value is skipped, never purged on an assumed default.

## Two-phase model

Subject deletion tombstones/redacts/erases immediately (phase 1) — Postgres customer-context rows get `deleted_at`, Identity Graph v2 evidence gets its identifier values redacted, ClickHouse rows are deleted outright (no tombstone concept there). The retention sweep (phase 2) physically purges anything left with `deleted_at` set, once its configured grace period elapses. This mirrors how most real-world LGPD/GDPR erasure pipelines work: soft-delete immediately (reversible within the grace window via the suppression reactivation path), hard-purge later (irreversible).

## Store-by-store classification

| Store | What it holds | Classification | Executed? | Notes |
|---|---|---|---|---|
| `postgres.customers` / `customer_identifiers` / `customer_traits` / `customer_relationships` | Canonical customer context (Order 30) | **delete** | ✅ (Order 035 tombstone, Order 055 retention-purge) | |
| `postgres.customer_outcomes` | Observed outcomes (Order 40) | **delete** | ✅ (Order 055) | Didn't exist in Order 035. |
| `postgres.outcome_definitions` | Workspace-level outcome config | **delete** | ✅ (workspace_deletion only) | Unchanged. |
| `postgres.identity_links` / `identity_merges` | Legacy v1 identity graph (M8) | **delete** | ✅ (Order 055) | `deleted_at` added (additive migration); `IdentityService` reads now filter it. |
| `postgres.identity_conflicts` / `identity_merge_events` | Identity Graph v2 audit evidence (Order 45) | **anonymize** | ✅ (Order 055) | Retained (it's an audit trail); identifier values redacted for the erased subject. Hard-deleted on workspace_deletion. |
| `postgres.connector_connections` + children | Connector Framework ledgers (Order 50) | **delete** | ✅ (workspace_deletion only) | Not subject-owned; nothing to do for subject_deletion. |
| `postgres.integrations` / `integration_out_configs` | Inbound/outbound integration credentials (M4/M9) | **delete** | ✅ (workspace_deletion only) | Hard-delete destroys the encrypted credential blob. |
| `postgres.user_profiles` | M15 profile projection | **reconstruct** | n/a | Derived cache — regenerates automatically. |
| `postgres.profile_access_log` | M15 LGPD access trail | **anonymize** | ❌ | Its own audit record with a separate retention policy — deliberately not touched by subject_deletion. Policy not yet defined by product (see HANDOFF). |
| `clickhouse.events` | Raw event stream (M2) | **delete** | ✅ (Order 055) | Synchronous `ALTER ... DELETE`, matched by every known identifier value (no `canonical_id` column on this table). |
| `clickhouse.touchpoints` | Attribution touchpoints (M7/M8) | **delete** | ✅ (Order 055) | Synchronous `ALTER ... DELETE` by `canonical_id`. |
| `clickhouse.*_daily` / materialized views | Aggregated/materialized projections | **reconstruct** | n/a | Derived — regenerate from `events` after the upstream purge. |
| `postgres.integration_out_logs` / `webhook_logs` | Outbound/inbound delivery logs (M4/M9) | **anonymize** | ❌ | Out of Order 055's explicit "at minimum" scope — residual risk, documented in the HANDOFF. |

## Suppression / tombstone against reconstruction (Order 055 §3)

`identity_suppressions` (workspace + provider_namespace + identifier_type + identifier_value, unique) is consulted by every write path that could re-create canonical identity for a deleted subject's old identifier: `CustomerContextService.synchronizeLegacyIdentity` (the v1 `identify()` bridge — and `identify()`'s own v1 `identity_links` write), and `IdentityGraphService.attachIdentifier`/`resolveOrCreateCustomer` (v2 — which the Connector Framework's `CanonicalMappingService` inherits automatically). `EventProjectionService` additionally refuses to write new outcome/trait data under a tombstoned `customers` row. Reactivation is a separate, explicit, audited write — never inferred from a replay simply missing a suppression row.

## Backup/recovery boundary

See `docs/operations/environments-and-release.md` → "Backup and recovery" for the provider/store responsibility matrix and the initial Postgres restore procedure required by Order 035 §6.
