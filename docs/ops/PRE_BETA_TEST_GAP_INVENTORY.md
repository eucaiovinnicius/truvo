# Pre-beta generic test gap inventory

Order 115 audited the 26 skips emitted by `pnpm test` when the generic runner has
no database/cache/analytics infrastructure configured. They are all deterministic
integration tests, not third-party dependencies. `pnpm test:prebeta` provisions
Postgres 16, Redis 7, ClickHouse 24.8 and Redpanda, applies migrations twice and
runs the same `@truvo/api` suite with **0 skips**.

Final classes: **26 Covered deterministic path; 0 Truly external**.

| # | Package / test | Generic reason / required infra | Domain / Order | Direct deterministic proof | Disposition |
|---:|---|---|---|---|---|
| 1 | API `customer-context.tenant-isolation` — cross-workspace same-id access | `DATABASE_URL`; Postgres | Customer Context / 30 | `pnpm test:prebeta` runs the exact test on disposable Postgres | Covered deterministic path |
| 2 | API `event-projection.tenant-isolation` — identify→purchase | `DATABASE_URL`; Postgres | Outcomes / 40 | Exact test under `test:prebeta` | Covered deterministic path |
| 3 | API `event-projection.merge-attribution` — merge convergence | `DATABASE_URL`; Postgres | Identity / 40–45 | Exact test plus Order 115 outcome reconciler runtime | Covered deterministic path |
| 4 | API `data-lifecycle.subject-erasure` — all stores | `DATABASE_URL` + ClickHouse | Privacy / 55 | Exact test under disposable PG/CH plus `test:decisions` | Covered deterministic path |
| 5 | API `data-lifecycle.subject-erasure` — partial failure/resume | `DATABASE_URL` + ClickHouse | Privacy / 55 | Exact test under `test:prebeta` | Covered deterministic path |
| 6 | API `retention-enforcement` — cutoff/idempotency/tenant | `DATABASE_URL`; Postgres | Lifecycle / 55 | Exact test plus operational-log runtime | Covered deterministic path |
| 7 | API `data-lifecycle.tenant-isolation` — workspace deletion | `DATABASE_URL` + ClickHouse | Lifecycle / 35–55 | Exact test under `test:prebeta` | Covered deterministic path |
| 8 | API `data-lifecycle.tenant-isolation` — subject idempotency | `DATABASE_URL` + ClickHouse | Lifecycle / 55 | Exact test under `test:prebeta` | Covered deterministic path |
| 9 | API `identity-graph.backfill` — v1 reconciliation/collision | `DATABASE_URL`; Postgres | Identity / 45 | Exact test under `test:prebeta` | Covered deterministic path |
| 10 | API `identity-graph.retro-stitch` — queue/checkpoint/reclaim | `REDIS_URL`; Redis | Identity / 45 | Exact test under disposable Redis | Covered deterministic path |
| 11 | API `identity-graph.tenant-isolation` — merge/unmerge | `DATABASE_URL`; Postgres | Identity / 45 | Exact test under `test:prebeta` | Covered deterministic path |
| 12 | API `connector-contract-kit` — deterministic provider | `DATABASE_URL`; Postgres | Connector Framework / 50 | Exact real-framework test under `test:prebeta` | Covered deterministic path |
| 13 | API `connector-tenant-isolation` | `DATABASE_URL`; Postgres | Connector Framework / 50 | Exact test under `test:prebeta` | Covered deterministic path |
| 14 | API `shopify.adapter.contract` | `DATABASE_URL`; Postgres; deterministic adapter | Shopify / 60 | Exact contract test under `test:prebeta` | Covered deterministic path |
| 15 | API `shopify.customer-merge` | `DATABASE_URL`; Postgres | Shopify/Identity / 60 | Exact test under `test:prebeta` | Covered deterministic path |
| 16 | API `hubspot.adapter.contract` | `DATABASE_URL`; Postgres; deterministic adapter | HubSpot / 61 | Exact contract test under `test:prebeta` | Covered deterministic path |
| 17 | API `hubspot.contract-kit` | `DATABASE_URL`; Postgres | HubSpot / 61 | Exact shared contract test under `test:prebeta` | Covered deterministic path |
| 18 | API `hubspot.association-reconciliation` | `DATABASE_URL`; Postgres | HubSpot / 61 | Exact reconciliation test under `test:prebeta` | Covered deterministic path |
| 19 | API `stripe.adapter.contract` | `DATABASE_URL`; Postgres; deterministic adapter | Stripe / 62 | Exact contract test under `test:prebeta` | Covered deterministic path |
| 20 | API `stripe.contract-kit` | `DATABASE_URL`; Postgres | Stripe / 62 | Exact shared contract test under `test:prebeta` | Covered deterministic path |
| 21 | API `stripe.customer-merge` — convergence | `DATABASE_URL`; Postgres | Stripe/Identity / 62 | Exact test under `test:prebeta` | Covered deterministic path |
| 22 | API `stripe.customer-merge` — suppression/deauth | `DATABASE_URL`; Postgres | Stripe/Privacy / 55–62 | Exact test under `test:prebeta` | Covered deterministic path |
| 23 | API `klaviyo.adapter.contract` | `DATABASE_URL`; Postgres; deterministic adapter | Klaviyo / 63 | Exact contract test under `test:prebeta` | Covered deterministic path |
| 24 | API `klaviyo.contract-kit` | `DATABASE_URL`; Postgres | Klaviyo / 63 | Exact shared contract test under `test:prebeta` | Covered deterministic path |
| 25 | API `klaviyo.customer-merge` — convergence | `DATABASE_URL`; Postgres | Klaviyo/Identity / 63 | Exact test under `test:prebeta` | Covered deterministic path |
| 26 | API `klaviyo.customer-merge` — privacy/tenant | `DATABASE_URL`; Postgres | Klaviyo/Privacy / 55–63 | Exact test under `test:prebeta` | Covered deterministic path |

The separate official Supabase Storage contract is not one of the generic 26:
`pnpm test:propensity` provisions the official storage-api image and private bucket,
so it is also deterministic and runs without a skip. No correctness-critical test
is classified as “environment not configured” without a disposable coverage path.
