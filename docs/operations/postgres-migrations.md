# Postgres migrations

`packages/db/migrations` is the repository-tracked Drizzle SQL history. Production and CI use `pnpm db:pg`, which obtains a Postgres advisory lock and applies migrations atomically through Drizzle's history table. Re-running it is a no-op when current.

For an existing audited v3.2 database, use `pnpm db:pg:adopt-baseline` once. The runner compares the committed Drizzle snapshot against Postgres tables, columns, types, nullability, defaults, primary/foreign keys, and relevant indexes before writing history. A mismatch fails before creating `drizzle.__drizzle_migrations`. It never drops or recreates application tables; record the verification in the release ticket. For an empty database, use `pnpm db:pg`.

`pnpm --filter @truvo/db db:push` is restricted to disposable local development and must not be used for staging or production. Production changes are additive, forward-fix preferred; do not manually edit migration history or destructively roll back a release.
