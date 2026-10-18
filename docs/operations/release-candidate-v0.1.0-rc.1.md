# Truvo MVP v0.1.0-rc.1

First MVP release candidate for Truvo AI Revenue Intelligence.

## Included capabilities

- authenticated workspace onboarding and tenant-aware application shell;
- event ingestion, identity/customer context, analytics, radars, propensity scoring,
  revenue opportunities, activation, decisions/actions, and Product Analytics;
- production API, event consumer, identity worker, propensity worker, and web images;
- versioned Postgres and ClickHouse migration artifacts;
- release identity, liveness/readiness, staging smoke, degraded-dependency checks,
  and application rollback/restart proof.

## Deployment requirements

- Follow `DEPLOY.md` and `docs/operations/environments-and-release.md`.
- Set `RELEASE_VERSION=v0.1.0-rc.1` and `RELEASE_COMMIT` to the exact release SHA.
- Apply the committed migration history before shifting traffic.
- Use isolated staging infrastructure and private Supabase model storage.
- Verify `/health`, `/health/ready`, release identity, authentication, workspace
  isolation, ingestion, opportunity generation, activation, and Product Analytics.

## Rollback

Redeploy the prior known-good application SHA, verify release identity and readiness,
then repeat the staging smoke. Database changes are forward-only: use verified
provider backups and additive forward-fixes; do not run destructive down migrations.

## Known limitations

- This release candidate does not itself deploy production infrastructure.
- Provider backup tiers, domains, secrets, and production deployment status must be
  confirmed in Supabase, Railway, and Vercel before a production launch.
- Optional Stripe, Ads, email, and Anthropic integrations remain fail-closed when
  their credentials are absent.
- Redis and Kafka are informative/degraded readiness dependencies under the current
  contract; Postgres and ClickHouse remain essential.

## Provenance

The final tag, release SHA, pull request, and post-merge CI run are recorded in the
EO 142 handoff and GitHub prerelease. Do not create the tag before post-merge CI is green.
