# Environments, CI/CD and release operations

This is the operational contract for Truvo releases. Existing providers are preserved: Vercel hosts `apps/web`; Railway runs the API, event consumer, identity worker, and propensity worker; Supabase provides Postgres/Auth and private model artifact storage; ClickHouse, Kafka and Redis remain managed infrastructure as documented in `DEPLOY.md`.

## Environment contract

| Environment | Configuration | Safety rules |
|---|---|---|
| Local | Copy `.env.example` to ignored `.env`; run `pnpm infra:up` before API/consumer. | Local credentials only; `TRUVO_DEV_AUTH_BYPASS=1` is permitted only outside production. |
| Preview / PR | Vercel preview sets `NEXT_PUBLIC_API_URL` to a non-production API intended for the PR. Railway preview is optional and provider-managed. | Never point a preview at production writable infrastructure or service-role secrets. |
| Staging | Use the production-required backend variables with staging Supabase/ClickHouse/Kafka/Redis and staging Vercel origin in `CORS_ORIGINS`. | Use isolated workspaces/test credentials and run the smoke checklist. |
| Production | Railway runs API, event consumer, identity worker, and propensity worker; Vercel builds `NEXT_PUBLIC_API_URL` into the web artifact. | `NODE_ENV=production`, non-empty `CORS_ORIGINS`, and `TRUVO_DEV_AUTH_BYPASS` other than `1` are enforced at API boot. |

The full variable list and service matrix remain in `.env.example` and `DEPLOY.md`. Required API boot variables are `SUPABASE_URL`, one Supabase key, `DATABASE_URL`, `CLICKHOUSE_URL`, `KAFKA_BROKERS`, and `REDIS_URL`. The API exits before opening dependencies when one is missing; optional integrations remain fail-closed. `NEXT_PUBLIC_API_URL` is a Vercel/Docker build-time input, never a secret.

Every deployed API must set `RELEASE_VERSION` and `RELEASE_COMMIT`. `GET /health` returns both; `pnpm release:identity` prints the exact local/CI release identity.

## Workspace-aware feature flags

`TRUVO_FEATURE_FLAGS` is the single backend-only release-flag convention:

```json
{"default":{"radar-preview":false},"workspaces":{"workspace-id":{"radar-preview":true}}}
```

Flags are parsed at API boot. Invalid values fail boot; missing/unknown flags are `false`. Evaluate only after workspace authentication/authorization with `isFeatureEnabled(flags, workspaceId, flag)`. Do not use client-side flags, URL parameters, or `NEXT_PUBLIC_*` for release gates.

## CI contract

`.github/workflows/ci.yml` runs on `main` pushes and pull requests: frozen pnpm install, static validation of the versioned Postgres and ClickHouse migration artifacts, lint, typecheck, general tests, Product Analytics, the pre-beta/staging regression chain, build, and release identity output with the GitHub SHA. Runtime migration tests use disposable databases in the regression chain; production migration application remains an explicit deploy step.

The canonical GitHub remote is configured. Protected merges must use the normal pull-request path with the `verify` job green; never use an administrative bypass for a release cut. Provider deployment status is separate from repository CI and must be verified in the provider consoles before production deployment.

## Staging smoke and release checklist

1. Run `pnpm release:identity` and compare it with the Railway/Vercel deployment commit.
2. Record `pnpm db:pg` and `pnpm db:ch` output from staging. Do not run them against production without a reviewed backup/change window.
3. Run `pnpm migration:validate`, then frozen install, lint, typecheck, test and build.
4. Deploy API, event consumer, identity worker, propensity worker, and web with staging URLs/secrets. Verify the propensity worker starts with its private artifact bucket and server-only credentials, and fails closed if artifact verification configuration is absent.
5. Verify `GET /health` release version/commit and `GET /health/ready` HTTP 200 with Postgres/ClickHouse healthy.
6. Authenticate on staging, switch workspaces, verify live mode has no demo data, and send one authorized tracking event using no production customer data.
7. Verify CORS from the staging Vercel origin, inspect browser assets for no production secret, and confirm a flagged feature is enabled only for its intended workspace.

## Backup and recovery (Order 035 §6)

Truvo does not run its own backup infrastructure — every stateful store is a managed provider, and backup/retention is that provider's responsibility. This table is the source of truth for who owns what; it does not replace the provider's own documentation.

| Store | Provider | Backup mechanism | Truvo's responsibility |
|---|---|---|---|
| Postgres (workspaces, customer context, billing, audit, etc.) | Supabase | Provider-managed automated backups (PITR on paid tiers; daily snapshot otherwise — confirm the actual tier before relying on a specific RPO). | Confirm the project's backup tier in the Supabase dashboard before go-live; never assume PITR without checking. |
| ClickHouse | Railway (or ClickHouse Cloud) | Provider/volume-level snapshot. Truvo does not run `BACKUP`/`RESTORE` statements itself. | Confirm the hosting choice's snapshot policy; ClickHouse data is also largely re-derivable from the Postgres canonical layer plus re-ingestion where the source system retains history. |
| Redpanda/Kafka | Railway (or Redpanda Cloud) | Broker-level retention window, not a backup. | Treat the queue as transient — it is not a system of record; do not rely on replaying it as a recovery mechanism. |
| Redis | Railway (or Upstash) | Provider snapshot (if configured) or none. | Redis holds caches/dedup/rate-limit state only — safe to lose and rebuild; not a backup target. |

### Initial restore procedure — Postgres (transactional store)

This is the **minimum reproducible procedure** required by Order 035 §6. It validates that a Supabase Postgres backup is actually restorable and that Truvo's versioned migration history stays consistent after a restore — it is not a full disaster-recovery runbook.

1. **Never restore into a database with real customer data still attached to it.** Use a disposable Supabase project or a local disposable Postgres for this validation.
2. In the Supabase dashboard of the source project, trigger a restore (PITR to a timestamp, or the latest daily snapshot) into a **new, disposable** project — do not restore in place onto a production project as a "test".
3. Point `DATABASE_URL` at the disposable restored project and run `pnpm migration:validate` — it must pass with the same result as against the source project (same schema shape, same migration history tag as of the restore point).
4. Run `pnpm db:pg` against the restored disposable project — it must be a no-op (already at head) or apply cleanly any migrations that shipped after the backup was taken.
5. Spot-check row counts on 2–3 core tables (`workspaces`, `customers`, `audit_log`) against the source project at the same point in time; discrepancies mean the backup/restore mechanism itself needs investigation with the provider before it can be trusted.
6. Tear down the disposable restored project. Record the date of this validation and its result in the release ticket — this is the "reproducible validation/runbook step" this order requires; repeat it periodically (e.g., each time the backup tier or schema changes materially), not only once.

## Rollback and forward-fix

For application-only defects, redeploy the previous known-good Railway/Vercel commit, confirm `/health` release identity, and repeat smoke checks. Disable a newly released workspace capability by setting its flag to `false` and redeploying the API; flags do not replace rollback for an unflagged defect.

Database rollback is constrained even with versioned Postgres migrations: the runner applies forward SQL under an advisory lock and the repository does not define automatic down migrations. ClickHouse DDL may also require a manual backfill. Take/verify backups, review schema changes in a disposable environment, and prefer additive forward-fixes to destructive reversals. Never use `drizzle-kit push` in staging or production.
