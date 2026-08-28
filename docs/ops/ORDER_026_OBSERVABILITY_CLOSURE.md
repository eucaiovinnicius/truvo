# Order 26 observability and reliability closure

Order 115 closes the remaining runtime evidence for the existing
`@truvo/observability` stack:

- consumer lag is computed from broker partition high-watermarks minus committed
  consumer-group offsets; only bounded `topic` and `group` dimensions are used;
- lag lookup failure records `consumer_lag_read_failures_total` and returns a safe
  empty sample without crashing ingestion;
- webhook verification failures use bounded `provider` plus `reason` values:
  `invalid_signature`, `timestamp`, and `replay` where the verifier supports them;
- critical consumer paths use `structuredLog`; the pre-beta policy scan rejects
  direct `console.*` calls in consumer entry/processing paths;
- `AlertHook` has deterministic runtime coverage for consumer lag, repeated
  connector failure, and propensity worker critical failure, including redaction;
- `/health`, `/health/ready`, and `/health/metrics` remain the provider-neutral
  staging signals. Production boot now requires exact `RELEASE_COMMIT` and
  `RELEASE_VERSION`, and rejects the development auth bypass.

Run `pnpm test:prebeta` for direct broker, logging, webhook and alert evidence.
