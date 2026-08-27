# Propensity worker (Order 090)

Independent Python 3.11 batch worker for Railway. Postgres `radar_training_requests`
is the job authority; Kafka topics are at-least-once wake-ups only. The process
claims a durable lease, builds weekly point-in-time snapshots, trains the two
accepted calibrated estimators, verifies a private Supabase Storage artifact,
scores the current audience, and reports through the internal Radar boundary.

Production command: `python -m propensity_worker`.

Required server-only environment:

- `DATABASE_URL`
- `KAFKA_BROKERS`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PROPENSITY_ARTIFACT_BUCKET` (pre-created private bucket)
- `INTERNAL_API_URL`
- `INTERNAL_API_SECRET`

Optional controls include `PROPENSITY_WORKER_ID`, `PROPENSITY_LEASE_SECONDS`,
`PROPENSITY_SNAPSHOT_CADENCE_DAYS`, `PROPENSITY_MAX_SNAPSHOTS`, and the shared
`RADAR_MIN_*` policy values. No signed URL, service key, provider customer ID, or
raw PII is persisted in model metadata, features, dispatches, or reason codes.

Development gates (from repository root):

```text
python -m pip install -r apps/propensity-worker/requirements-dev.txt
python -m ruff check apps/propensity-worker
python -m mypy apps/propensity-worker/propensity_worker
python -m unittest discover -s apps/propensity-worker/tests -t apps/propensity-worker -v
```
