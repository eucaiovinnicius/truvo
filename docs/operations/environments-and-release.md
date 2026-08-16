# Environments, CI/CD and release operations

This is the operational contract for Truvo releases. Existing providers are preserved: Vercel hosts `apps/web`; Railway runs the API and two consumer processes; Supabase provides Postgres/Auth; ClickHouse, Kafka and Redis remain managed infrastructure as documented in `DEPLOY.md`.

## Environment contract

| Environment | Configuration | Safety rules |
|---|---|---|
| Local | Copy `.env.example` to ignored `.env`; run `pnpm infra:up` before API/consumer. | Local credentials only; `TRUVO_DEV_AUTH_BYPASS=1` is permitted only outside production. |
| Preview / PR | Vercel preview sets `NEXT_PUBLIC_API_URL` to a non-production API intended for the PR. Railway preview is optional and provider-managed. | Never point a preview at production writable infrastructure or service-role secrets. |
| Staging | Use the production-required backend variables with staging Supabase/ClickHouse/Kafka/Redis and staging Vercel origin in `CORS_ORIGINS`. | Use isolated workspaces/test credentials and run the smoke checklist. |
| Production | Railway runs API/consumer/identity worker; Vercel builds `NEXT_PUBLIC_API_URL` into the web artifact. | `NODE_ENV=production`, non-empty `CORS_ORIGINS`, and `TRUVO_DEV_AUTH_BYPASS` other than `1` are enforced at API boot. |

The full variable list and service matrix remain in `.env.example` and `DEPLOY.md`. Required API boot variables are `SUPABASE_URL`, one Supabase key, `DATABASE_URL`, `CLICKHOUSE_URL`, `KAFKA_BROKERS`, and `REDIS_URL`. The API exits before opening dependencies when one is missing; optional integrations remain fail-closed. `NEXT_PUBLIC_API_URL` is a Vercel/Docker build-time input, never a secret.

Every deployed API must set `RELEASE_VERSION` and `RELEASE_COMMIT`. `GET /health` returns both; `pnpm release:identity` prints the exact local/CI release identity.

## Workspace-aware feature flags

`TRUVO_FEATURE_FLAGS` is the single backend-only release-flag convention:

```json
{"default":{"radar-preview":false},"workspaces":{"workspace-id":{"radar-preview":true}}}
```

Flags are parsed at API boot. Invalid values fail boot; missing/unknown flags are `false`. Evaluate only after workspace authentication/authorization with `isFeatureEnabled(flags, workspaceId, flag)`. Do not use client-side flags, URL parameters, or `NEXT_PUBLIC_*` for release gates.

## CI contract

`.github/workflows/ci.yml` runs on `main` pushes and pull requests: frozen pnpm install, `pnpm migration:validate`, lint, typecheck, tests, build, and release identity output with the GitHub SHA. Migration validation is static and validates existing ClickHouse DDL naming/order only. It neither connects to a database nor implements/applies a versioned Postgres migration framework; that remains Execution Order 27.

This checkout has no Git remote. Branch protection, required checks, preview deployments and provider status are therefore unverified. Configure the remote repository to require the `verify` job before merge.

## Staging smoke and release checklist

1. Run `pnpm release:identity` and compare it with the Railway/Vercel deployment commit.
2. Record `pnpm db:pg` and `pnpm db:ch` output from staging. Do not run them against production without a reviewed backup/change window.
3. Run `pnpm migration:validate`, then frozen install, lint, typecheck, test and build.
4. Deploy API, consumer, identity worker and web with staging URLs/secrets.
5. Verify `GET /health` release version/commit and `GET /health/ready` HTTP 200 with Postgres/ClickHouse healthy.
6. Authenticate on staging, switch workspaces, verify live mode has no demo data, and send one authorized tracking event using no production customer data.
7. Verify CORS from the staging Vercel origin, inspect browser assets for no production secret, and confirm a flagged feature is enabled only for its intended workspace.

## Rollback and forward-fix

For application-only defects, redeploy the previous known-good Railway/Vercel commit, confirm `/health` release identity, and repeat smoke checks. Disable a newly released workspace capability by setting its flag to `false` and redeploying the API; flags do not replace rollback for an unflagged defect.

Database rollback is constrained: Postgres uses `drizzle-kit push` and has no versioned, reversible migration history; ClickHouse DDL may be additive or require a manual backfill. Take/verify backups, review schema diffs in a disposable environment, and prefer forward-fixes to destructive reversals. Execution Order 27 must establish versioned Postgres migrations before schema changes are automatically rollbackable.
