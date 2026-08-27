"""Postgres authority for propensity jobs, features, models and score batches."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import os
from typing import Iterable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .contracts import TrainingDispatch
from .core import FEATURE_SCHEMA_VERSION, Observation, Snapshot, TrainingResult, build_snapshot, utc


TERMINAL_REQUEST_STATUSES = ("succeeded", "failed", "insufficient_data", "superseded")


@dataclass(frozen=True)
class TrainingJob:
    dispatch: TrainingDispatch
    audience_ast: dict[str, object]
    outcome_definition_id: str
    prediction_window_days: int
    attempt_count: int


@dataclass(frozen=True)
class ClaimResult:
    state: str
    job: TrainingJob | None = None


@dataclass(frozen=True)
class PersistedModel:
    model_version_id: str
    workspace_id: str
    radar_id: str
    definition_version: int
    training_request_id: str
    artifact_bucket: str
    artifact_object_key: str
    artifact_checksum: str
    artifact_reference: str
    estimator_type: str
    feature_schema_version: str
    verified_at: datetime


class PostgresRepository:
    def __init__(self, database_url: str):
        if not database_url.startswith(("postgres://", "postgresql://")):
            raise ValueError("DATABASE_URL must be PostgreSQL")
        self.database_url = database_url

    def _connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def claim_training(self, dispatch: TrainingDispatch, worker_id: str, lease_seconds: int) -> ClaimResult:
        with self._connect() as connection, connection.transaction():
            row = connection.execute(
                """
                select tr.*, r.current_definition_version, r.status as radar_status,
                       d.audience_ast, d.outcome_definition_id, d.prediction_window_days,
                       od.is_active as outcome_active, od.deleted_at as outcome_deleted_at
                from radar_training_requests tr
                join radars r on r.workspace_id=tr.workspace_id and r.id=tr.radar_id
                join radar_definition_versions d on d.workspace_id=tr.workspace_id and d.radar_id=tr.radar_id and d.version=tr.definition_version
                left join outcome_definitions od on od.workspace_id=d.workspace_id and od.id=d.outcome_definition_id
                where tr.workspace_id=%s and tr.id=%s
                for update of tr
                """,
                (dispatch.workspace_id, dispatch.training_request_id),
            ).fetchone()
            if not row:
                return ClaimResult("not_found")
            if row["radar_id"] != dispatch.radar_id or row["definition_version"] != dispatch.definition_version or row["correlation_id"] != dispatch.correlation_id:
                return ClaimResult("dispatch_mismatch")
            if row["status"] in TERMINAL_REQUEST_STATUSES:
                return ClaimResult("terminal")
            job = TrainingJob(dispatch, row["audience_ast"], row["outcome_definition_id"], row["prediction_window_days"], int(row["attempt_count"] or 0))
            current = row["current_definition_version"] == dispatch.definition_version and row["radar_status"] == "training"
            if not current:
                connection.execute(
                    """update radar_training_requests set status='superseded', claimed_by=null, claimed_at=null,
                       lease_expires_at=null, terminal_at=clock_timestamp(), failure_category='stale_definition',
                       failure_reason='request definition is no longer current', updated_at=clock_timestamp()
                       where workspace_id=%s and id=%s""",
                    (dispatch.workspace_id, dispatch.training_request_id),
                )
                return ClaimResult("stale")
            if row["outcome_active"] is not True or row["outcome_deleted_at"] is not None:
                return ClaimResult("target_unavailable", job)
            now = connection.execute("select clock_timestamp() as now").fetchone()["now"]
            if row["status"] == "running" and row["lease_expires_at"] and row["lease_expires_at"] > now:
                return ClaimResult("leased")
            claimed = connection.execute(
                """update radar_training_requests set status='running', claimed_by=%s, claimed_at=clock_timestamp(),
                   lease_expires_at=clock_timestamp()+(%s * interval '1 second'), attempt_count=attempt_count+1,
                   updated_at=clock_timestamp() where workspace_id=%s and id=%s returning attempt_count""",
                (worker_id, lease_seconds, dispatch.workspace_id, dispatch.training_request_id),
            ).fetchone()
            return ClaimResult("claimed", TrainingJob(dispatch, row["audience_ast"], row["outcome_definition_id"], row["prediction_window_days"], int(claimed["attempt_count"])))

    def heartbeat(self, dispatch: TrainingDispatch, worker_id: str, lease_seconds: int) -> bool:
        with self._connect() as connection:
            updated = connection.execute(
                """update radar_training_requests set lease_expires_at=clock_timestamp()+(%s * interval '1 second'),
                   updated_at=clock_timestamp() where workspace_id=%s and id=%s and status='running'
                   and claimed_by=%s and lease_expires_at>clock_timestamp() returning id""",
                (lease_seconds, dispatch.workspace_id, dispatch.training_request_id, worker_id),
            ).fetchone()
            return bool(updated)

    def _audience_matches(self, ast: dict[str, object], customer: dict[str, object], traits: dict[str, object], prior_outcomes: set[str]) -> bool:
        op = ast.get("op")
        if op == "identified":
            return customer.get("status") == "identified"
        if op == "trait":
            key = str(ast.get("key", ""))
            return key in traits if ast.get("operator") == "exists" else traits.get(key) == ast.get("value")
        if op == "outcome_occurred":
            return str(ast.get("outcomeDefinitionId")) in prior_outcomes
        children = ast.get("children")
        if op in ("and", "or") and isinstance(children, list):
            values = [self._audience_matches(child, customer, traits, prior_outcomes) for child in children if isinstance(child, dict)]
            return all(values) if op == "and" else any(values)
        return False

    def _context_for_customers(self, connection, workspace_id: str, customer_ids: list[str], target_outcome: str) -> tuple[dict[str, list[Observation]], dict[str, list[tuple[datetime, str, object]]], dict[str, list[tuple[datetime, str]]]]:
        observations: dict[str, list[Observation]] = {customer_id: [] for customer_id in customer_ids}
        traits: dict[str, list[tuple[datetime, str, object]]] = {customer_id: [] for customer_id in customer_ids}
        outcomes_by_definition: dict[str, list[tuple[datetime, str]]] = {customer_id: [] for customer_id in customer_ids}
        if not customer_ids:
            return observations, traits, outcomes_by_definition

        for row in connection.execute(
            """select customer_id,outcome_definition_id,observed_at,coalesce(value,1)::float8 as value
               from customer_outcomes where workspace_id=%s and customer_id=any(%s) and deleted_at is null order by observed_at""",
            (workspace_id, customer_ids),
        ):
            kind = "target" if row["outcome_definition_id"] == target_outcome else "outcome"
            observations[row["customer_id"]].append(Observation(row["customer_id"], kind, row["observed_at"], float(row["value"])))
            outcomes_by_definition[row["customer_id"]].append((row["observed_at"], row["outcome_definition_id"]))
        for row in connection.execute(
            """select customer_id,order_timestamp,total_amount::float8 as value from commerce_orders
               where workspace_id=%s and customer_id=any(%s) order by order_timestamp""",
            (workspace_id, customer_ids),
        ):
            observations[row["customer_id"]].append(Observation(row["customer_id"], "purchase", row["order_timestamp"], float(row["value"])))
        for row in connection.execute(
            """select customer_id,occurred_at from engagement_events where workspace_id=%s and customer_id=any(%s) order by occurred_at""",
            (workspace_id, customer_ids),
        ):
            observations[row["customer_id"]].append(Observation(row["customer_id"], "engagement", row["occurred_at"]))
        for row in connection.execute(
            """select customer_id,source_updated_at,status from billing_context_subscriptions
               where workspace_id=%s and customer_id=any(%s) order by source_updated_at""",
            (workspace_id, customer_ids),
        ):
            if str(row["status"]).lower() in ("active", "trialing"):
                observations[row["customer_id"]].append(Observation(row["customer_id"], "subscription_active", row["source_updated_at"]))
        for row in connection.execute(
            """select a.from_object_id as customer_id, greatest(a.observed_at,d.deal_timestamp) as occurred_at,d.status
               from crm_associations a join crm_deals d on d.workspace_id=a.workspace_id and d.id=a.to_object_id
               where a.workspace_id=%s and a.from_object_type='contact' and a.to_object_type='deal'
                 and a.from_object_id=any(%s) and a.deleted_at is null and d.deleted_at is null""",
            (workspace_id, customer_ids),
        ):
            if str(row["status"] or "").lower() not in ("closed", "won", "lost"):
                observations[row["customer_id"]].append(Observation(row["customer_id"], "crm_open", row["occurred_at"]))
        for row in connection.execute(
            """select customer_id,trait_key,value,observed_at from customer_traits
               where workspace_id=%s and customer_id=any(%s) and trait_namespace='canonical' and deleted_at is null order by observed_at""",
            (workspace_id, customer_ids),
        ):
            traits[row["customer_id"]].append((row["observed_at"], row["trait_key"], row["value"]))
            if row["trait_key"] == "acquisition_source":
                observations[row["customer_id"]].append(Observation(row["customer_id"], "acquisition_known", row["observed_at"]))
        return observations, traits, outcomes_by_definition

    def build_training_dataset(self, job: TrainingJob, as_of: datetime, chunk_size: int = 500) -> list[Snapshot]:
        latest_cutoff = utc(as_of) - timedelta(days=job.prediction_window_days)
        cadence_days = int(os.getenv("PROPENSITY_SNAPSHOT_CADENCE_DAYS", "7"))
        max_snapshots = int(os.getenv("PROPENSITY_MAX_SNAPSHOTS", "200000"))
        snapshots: list[Snapshot] = []
        last_id = ""
        with self._connect() as connection:
            while True:
                customers = connection.execute(
                    """select id,status,first_seen_at,last_seen_at from customers where workspace_id=%s
                       and deleted_at is null and id>%s order by id limit %s""",
                    (job.dispatch.workspace_id, last_id, chunk_size),
                ).fetchall()
                if not customers:
                    break
                ids = [row["id"] for row in customers]
                observations, traits, outcomes = self._context_for_customers(connection, job.dispatch.workspace_id, ids, job.outcome_definition_id)
                for customer in customers:
                    cutoff = utc(customer["first_seen_at"]).replace(hour=0, minute=0, second=0, microsecond=0)
                    while cutoff <= latest_cutoff:
                        trait_values = {key: value for observed, key, value in traits[customer["id"]] if utc(observed) <= cutoff}
                        prior_outcomes = {definition for observed, definition in outcomes[customer["id"]] if utc(observed) <= cutoff}
                        if self._audience_matches(job.audience_ast, customer, trait_values, prior_outcomes):
                            snapshots.append(build_snapshot(job.dispatch.workspace_id, customer["id"], cutoff, job.prediction_window_days, observations[customer["id"]], "target"))
                            if len(snapshots) > max_snapshots:
                                raise ValueError("dataset_exceeds_bounded_snapshot_limit")
                        cutoff += timedelta(days=cadence_days)
                last_id = ids[-1]
        return sorted(snapshots, key=lambda row: (row.cutoff, row.customer_id))

    def build_scoring_dataset(self, job: TrainingJob, scoring_cutoff: datetime, chunk_size: int = 500) -> list[Snapshot]:
        snapshots: list[Snapshot] = []
        last_id = ""
        with self._connect() as connection:
            while True:
                customers = connection.execute(
                    """select id,status,first_seen_at,last_seen_at from customers where workspace_id=%s
                       and deleted_at is null and id>%s order by id limit %s""",
                    (job.dispatch.workspace_id, last_id, chunk_size),
                ).fetchall()
                if not customers: break
                ids = [row["id"] for row in customers]
                observations, traits, outcomes = self._context_for_customers(connection, job.dispatch.workspace_id, ids, job.outcome_definition_id)
                for customer in customers:
                    trait_values = {key: value for observed, key, value in traits[customer["id"]] if utc(observed) <= scoring_cutoff}
                    prior_outcomes = {definition for observed, definition in outcomes[customer["id"]] if utc(observed) <= scoring_cutoff}
                    if self._audience_matches(job.audience_ast, customer, trait_values, prior_outcomes):
                        snapshots.append(build_snapshot(job.dispatch.workspace_id, customer["id"], scoring_cutoff, job.prediction_window_days, observations[customer["id"]], "target", with_label=False))
                last_id = ids[-1]
        return snapshots

    def existing_model_for_request(self, dispatch: TrainingDispatch) -> PersistedModel | None:
        with self._connect() as connection:
            row = connection.execute(
                """select id,workspace_id,radar_id,definition_version,training_request_id,artifact_bucket,
                   artifact_object_key,artifact_checksum,artifact_reference,estimator_type,feature_schema_version,verified_at
                   from radar_model_versions where workspace_id=%s and training_request_id=%s""",
                (dispatch.workspace_id, dispatch.training_request_id),
            ).fetchone()
            return PersistedModel(row["id"], row["workspace_id"], row["radar_id"], row["definition_version"], row["training_request_id"], row["artifact_bucket"], row["artifact_object_key"], row["artifact_checksum"], row["artifact_reference"], row["estimator_type"], row["feature_schema_version"], row["verified_at"]) if row else None

    def current_scoring_job(self, dispatch: TrainingDispatch) -> tuple[TrainingJob, PersistedModel] | None:
        with self._connect() as connection:
            row = connection.execute(
                """select d.audience_ast,d.outcome_definition_id,d.prediction_window_days,
                          m.id,m.workspace_id,m.radar_id,m.definition_version,m.training_request_id,m.artifact_bucket,
                          m.artifact_object_key,m.artifact_checksum,m.artifact_reference,m.estimator_type,m.feature_schema_version,m.verified_at
                   from radar_training_requests tr
                   join radars r on r.workspace_id=tr.workspace_id and r.id=tr.radar_id
                   join radar_model_versions m on m.workspace_id=r.workspace_id and m.id=r.current_model_reference
                   join radar_definition_versions d on d.workspace_id=r.workspace_id and d.radar_id=r.id and d.version=r.current_definition_version
                   where tr.workspace_id=%s and tr.id=%s and tr.radar_id=%s and tr.definition_version=%s
                     and tr.correlation_id=%s and tr.status='succeeded' and r.status='active'
                     and m.training_request_id=tr.id and m.status='active'""",
                (dispatch.workspace_id, dispatch.training_request_id, dispatch.radar_id, dispatch.definition_version, dispatch.correlation_id),
            ).fetchone()
            if not row: return None
            job = TrainingJob(dispatch, row["audience_ast"], row["outcome_definition_id"], row["prediction_window_days"], 0)
            model = PersistedModel(row["id"], row["workspace_id"], row["radar_id"], row["definition_version"], row["training_request_id"], row["artifact_bucket"], row["artifact_object_key"], row["artifact_checksum"], row["artifact_reference"], row["estimator_type"], row["feature_schema_version"], row["verified_at"])
            return job, model

    def persist_model(self, job: TrainingJob, model_version_id: str, result: TrainingResult, artifact, verified_at: datetime) -> PersistedModel:
        candidate_metrics = {name: value.metrics for name, value in result.candidates.items()}
        calibration = {"method": result.selected.calibration_method, "fit_period": result.split_ranges["calibration"], "test_brier": result.selected.metrics["brier"], "buckets": result.selected.metrics["calibration_buckets"]}
        with self._connect() as connection:
            row = connection.execute(
                """insert into radar_model_versions
                   (workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,
                    prediction_window_days,status,estimator_type,feature_schema_version,artifact_provider,artifact_bucket,
                    artifact_object_key,artifact_reference,artifact_checksum,serialization_format,cutoff_ranges,data_counts,
                    metrics,calibration,provenance,validation,selection_reason,verified_at)
                   values (%s,%s,%s,%s,%s,%s,%s,'training',%s,%s,%s,%s,%s,%s,%s,'joblib-v1',%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (workspace_id,training_request_id) do update set verified_at=excluded.verified_at
                   returning id,workspace_id,radar_id,definition_version,training_request_id,artifact_bucket,
                             artifact_object_key,artifact_checksum,artifact_reference,estimator_type,feature_schema_version,verified_at""",
                (job.dispatch.workspace_id, model_version_id, job.dispatch.radar_id, job.dispatch.definition_version,
                 job.dispatch.training_request_id, job.outcome_definition_id, job.prediction_window_days,
                 result.selected.estimator_type, FEATURE_SCHEMA_VERSION, artifact.provider, artifact.bucket,
                 artifact.object_key, artifact.reference, artifact.checksum, Jsonb(result.split_ranges), Jsonb(result.data_counts),
                 Jsonb(candidate_metrics), Jsonb(calibration), Jsonb({"worker_version": "propensity-worker-v1", "feature_schema_version": FEATURE_SCHEMA_VERSION, "split_counts": result.data_counts, "split_ranges": result.split_ranges, "training_attempt": job.attempt_count}), Jsonb({"artifact_verified_at": verified_at.isoformat(), "artifact_checksum": artifact.checksum}), result.selection_reason, verified_at),
            ).fetchone()
            return PersistedModel(row["id"], row["workspace_id"], row["radar_id"], row["definition_version"], row["training_request_id"], row["artifact_bucket"], row["artifact_object_key"], row["artifact_checksum"], row["artifact_reference"], row["estimator_type"], row["feature_schema_version"], row["verified_at"])

    def is_current(self, job: TrainingJob) -> bool:
        with self._connect() as connection:
            row = connection.execute("select current_definition_version,status from radars where workspace_id=%s and id=%s", (job.dispatch.workspace_id, job.dispatch.radar_id)).fetchone()
            return bool(row and row["current_definition_version"] == job.dispatch.definition_version and row["status"] == "training")

    def mark_stale(self, job: TrainingJob, model_version_id: str | None = None) -> None:
        with self._connect() as connection, connection.transaction():
            if model_version_id:
                connection.execute("update radar_model_versions set status='historical' where workspace_id=%s and id=%s", (job.dispatch.workspace_id, model_version_id))
            connection.execute(
                """update radar_training_requests set status='superseded',failure_category='stale_definition',
                   failure_reason='completed model does not match current Radar definition', claimed_by=null,
                   lease_expires_at=null,terminal_at=clock_timestamp(),updated_at=clock_timestamp()
                   where workspace_id=%s and id=%s and status not in ('succeeded','failed','insufficient_data','superseded')""",
                (job.dispatch.workspace_id, job.dispatch.training_request_id),
            )

    def persist_scores(self, job: TrainingJob, model: PersistedModel, cutoff: datetime, rows: list[Snapshot], probabilities: Iterable[float], reasons: list[list[str]], worker_id: str) -> tuple[int, str]:
        cutoff = utc(cutoff).replace(second=0, microsecond=0)
        scored = list(zip(rows, probabilities, reasons))
        with self._connect() as connection, connection.transaction():
            current = connection.execute("select current_definition_version,status,current_model_reference from radars where workspace_id=%s and id=%s for update", (job.dispatch.workspace_id, job.dispatch.radar_id)).fetchone()
            allowed = current and current["current_definition_version"] == job.dispatch.definition_version and (
                current["status"] == "training" or (current["status"] == "active" and current["current_model_reference"] == model.model_version_id)
            )
            if not allowed:
                return 0, "stale"
            existing = connection.execute(
                """select status,scored_customer_count,claimed_by,(lease_expires_at>clock_timestamp()) as lease_valid from radar_score_batches where workspace_id=%s and radar_id=%s
                   and model_version_id=%s and scoring_cutoff=%s for update""",
                (job.dispatch.workspace_id, job.dispatch.radar_id, model.model_version_id, cutoff),
            ).fetchone()
            if existing and existing["status"] == "completed":
                return int(existing["scored_customer_count"]), "idempotent"
            if existing and existing["status"] == "running" and existing.get("lease_valid") and existing.get("claimed_by") != worker_id:
                return 0, "leased"
            connection.execute(
                """insert into radar_score_batches (workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,claimed_by,lease_expires_at,attempt_count)
                   values (%s,%s,%s,%s,%s,'running',%s,clock_timestamp()+interval '10 minutes',1)
                   on conflict (workspace_id,radar_id,model_version_id,scoring_cutoff) do update set
                     status='running',claimed_by=excluded.claimed_by,lease_expires_at=excluded.lease_expires_at,
                     attempt_count=radar_score_batches.attempt_count+1,updated_at=clock_timestamp()""",
                (job.dispatch.workspace_id, job.dispatch.radar_id, job.dispatch.definition_version, model.model_version_id, cutoff, worker_id),
            )
            for snapshot, probability, signal_codes in scored:
                probability = float(probability)
                if probability < 0 or probability > 1 or snapshot.workspace_id != job.dispatch.workspace_id:
                    raise ValueError("invalid score provenance")
                connection.execute(
                    """insert into radar_propensity_scores
                       (workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (workspace_id,radar_id,model_version_id,customer_id,scoring_cutoff) do update set
                         probability=excluded.probability,feature_schema_version=excluded.feature_schema_version,
                         reason_codes=excluded.reason_codes,scored_at=clock_timestamp()""",
                    (job.dispatch.workspace_id, job.dispatch.radar_id, job.dispatch.definition_version, model.model_version_id,
                     snapshot.customer_id, cutoff, probability, snapshot.feature_schema_version, Jsonb(signal_codes)),
                )
            connection.execute(
                """update radar_score_batches set status='completed',scored_customer_count=%s,completed_at=clock_timestamp(),
                   claimed_by=null,lease_expires_at=null,updated_at=clock_timestamp() where workspace_id=%s and radar_id=%s
                   and model_version_id=%s and scoring_cutoff=%s""",
                (len(scored), job.dispatch.workspace_id, job.dispatch.radar_id, model.model_version_id, cutoff),
            )
            return len(scored), "executed"

    def mark_dispatch(self, dispatch: TrainingDispatch) -> None:
        with self._connect() as connection:
            connection.execute("update radar_training_requests set last_dispatched_at=clock_timestamp(),updated_at=clock_timestamp() where workspace_id=%s and id=%s", (dispatch.workspace_id, dispatch.training_request_id))
