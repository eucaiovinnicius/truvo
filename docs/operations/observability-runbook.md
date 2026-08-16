# Observability and reliability runbook

Truvo emits JSON structured logs with `service`, `environment`, `event`, and safe contextual fields. Request logs include `requestId`; async internal forwards propagate it as `x-request-id`. Sensitive keys (tokens, API keys, secrets, cookies, email, raw payloads and event properties/context) are redacted by the shared `@truvo/observability` primitive.

## Signals and investigation

1. Start with `/health` for process/release identity and `/health/ready` for dependency state. Postgres and ClickHouse are essential; Redis and Kafka are explicitly informative/degraded.
2. Inspect `/health/metrics` and structured logs for `http_errors_total`, `ingestion_accepted_total`, `ingestion_rejected_total`, `queue_failures_total`, `consumer_events_processed_total`, `storage_writes_total`, `consumer_retry_buffer_rows`, and `connector_failures_total`.
3. Filter logs by `requestId`/`correlationId`, module, workspace context when a caller has safely provided it, then failure class.
4. `transient` failures (timeouts, 408, 429, 5xx, transport) retain retry state; storage failures requeue buffered rows and Kafka offsets are not committed. `permanent` malformed payloads are sent to the capped Redis DLQ.
5. For queue/storage failures, verify dependency health first; do not replay or purge DLQ entries before preserving the correlation ID and reason.

## Alert integration

`AlertHook` is provider-neutral. A deployment may attach an adapter that forwards critical structured events to its existing provider. No vendor, webhook URL, or business threshold is hard-coded. Choose technical thresholds per environment and alert on sustained failure/error rates, not a single transient failure.

## Deferred signals

Future connector/job subsystems should use `metrics.increment` and `emitAlert` with module/connector/job context. Detailed consumer lag needs broker/provider telemetry and is not inferred from a database query in this foundation.
