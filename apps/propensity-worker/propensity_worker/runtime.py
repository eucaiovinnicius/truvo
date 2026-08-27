from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import logging
import threading

import numpy as np

from .artifact_store import ArtifactStore, ArtifactStoreError, model_object_key
from .contracts import TrainingDispatch
from .core import MinimumDataPolicy, InsufficientDataError, artifact_checksum, deserialize_bundle, serialize_bundle, train, utc
from .repository import PostgresRepository, TrainingJob
from .result_client import RadarResultClient, ResultBoundaryError

logger = logging.getLogger("truvo.propensity-worker")


@dataclass(frozen=True)
class WorkerConfig:
    worker_id: str
    lease_seconds: int = 300
    min_labeled_examples: int = 1_000
    min_positives: int = 100
    min_negatives: int = 100


class LeaseKeeper:
    def __init__(self, repository: PostgresRepository, dispatch: TrainingDispatch, worker_id: str, lease_seconds: int):
        self.repository, self.dispatch, self.worker_id, self.lease_seconds = repository, dispatch, worker_id, lease_seconds
        self._stop = threading.Event()
        self._lost = threading.Event()
        self._thread = threading.Thread(target=self._run, name="propensity-lease-heartbeat", daemon=True)

    def _run(self):
        while not self._stop.wait(max(1, self.lease_seconds // 3)):
            try:
                if not self.repository.heartbeat(self.dispatch, self.worker_id, self.lease_seconds):
                    self._lost.set(); return
            except Exception:
                self._lost.set(); return

    def __enter__(self): self._thread.start(); return self
    def __exit__(self, *_): self._stop.set(); self._thread.join(timeout=2)
    def assert_owned(self):
        if self._lost.is_set(): raise RuntimeError("training_lease_lost")


class PropensityRuntime:
    def __init__(self, repository: PostgresRepository, artifact_store: ArtifactStore,
                 result_client: RadarResultClient, config: WorkerConfig, clock=lambda: datetime.now(timezone.utc)):
        self.repository, self.artifact_store, self.result_client, self.config, self.clock = repository, artifact_store, result_client, config, clock

    def _report_failure(self, dispatch: TrainingDispatch, category: str, reason: str) -> None:
        try:
            self.result_client.report(dispatch, "failed", failure_category=category, failure_reason=reason)
        except ResultBoundaryError:
            logger.error("failed to report terminal worker failure workspace=%s radar=%s request=%s", dispatch.workspace_id, dispatch.radar_id, dispatch.training_request_id)

    def process(self, dispatch: TrainingDispatch) -> dict[str, object]:
        claim = self.repository.claim_training(dispatch, self.config.worker_id, self.config.lease_seconds)
        if claim.state == "target_unavailable":
            self.result_client.report(dispatch, "insufficient_data", failure_category="insufficient_data", failure_reason="target_outcome_unavailable")
            return {"status": "insufficient_data", "blockers": ["target_outcome_unavailable"]}
        if claim.state != "claimed" or not claim.job:
            return {"status": claim.state, "trainingRequestId": dispatch.training_request_id}
        job = claim.job
        try:
            with LeaseKeeper(self.repository, dispatch, self.config.worker_id, self.config.lease_seconds) as lease:
                result = self._train_or_resume(job, lease)
                return result
        except InsufficientDataError as error:
            self.result_client.report(dispatch, "insufficient_data", failure_category="insufficient_data", failure_reason=",".join(error.blockers))
            return {"status": "insufficient_data", "counts": error.counts, "blockers": error.blockers}
        except ResultBoundaryError:
            raise
        except ArtifactStoreError as error:
            self._report_failure(dispatch, "artifact_error", str(error))
            return {"status": "failed", "failureCategory": "artifact_error"}
        except Exception as error:
            self._report_failure(dispatch, "worker_error", str(error))
            return {"status": "failed", "failureCategory": "worker_error"}

    def _train_or_resume(self, job: TrainingJob, lease: LeaseKeeper) -> dict[str, object]:
        now = utc(self.clock())
        existing = self.repository.existing_model_for_request(job.dispatch)
        if existing:
            payload = self.artifact_store.get(existing.artifact_object_key)
            if artifact_checksum(payload) != existing.artifact_checksum:
                raise ArtifactStoreError("persisted artifact checksum mismatch")
            bundle = deserialize_bundle(payload)
            model = existing
            training_result = None
        else:
            dataset = self.repository.build_training_dataset(job, now)
            lease.assert_owned()
            training_result = train(dataset, MinimumDataPolicy(self.config.min_labeled_examples, self.config.min_positives, self.config.min_negatives))
            model_version_id = "mdl_" + sha256(f"{job.dispatch.workspace_id}:{job.dispatch.training_request_id}".encode()).hexdigest()[:24]
            payload = serialize_bundle(training_result.selected.bundle)
            checksum = artifact_checksum(payload)
            object_key = model_object_key(job.dispatch.workspace_id, job.dispatch.radar_id, job.dispatch.definition_version, model_version_id)
            artifact = self.artifact_store.put_and_verify(object_key, payload, checksum)
            reloaded = deserialize_bundle(self.artifact_store.get(object_key))
            smoke_rows = dataset[-min(5, len(dataset)):]
            if not np.allclose(training_result.selected.bundle.predict(smoke_rows), reloaded.predict(smoke_rows), atol=1e-12):
                raise ArtifactStoreError("artifact prediction smoke test mismatch")
            lease.assert_owned()
            model = self.repository.persist_model(job, model_version_id, training_result, artifact, now)
            bundle = reloaded

        if not self.repository.is_current(job):
            self.repository.mark_stale(job, model.model_version_id)
            return {"status": "stale", "modelVersionId": model.model_version_id}
        scoring_cutoff = utc(model.verified_at).replace(second=0, microsecond=0)
        scoring_rows = self.repository.build_scoring_dataset(job, scoring_cutoff)
        probabilities = bundle.predict(scoring_rows) if scoring_rows else np.asarray([], dtype=float)
        signal_codes = [bundle.signal_codes(row) for row in scoring_rows]
        scored_count, score_state = self.repository.persist_scores(job, model, scoring_cutoff, scoring_rows, probabilities, signal_codes, self.config.worker_id)
        if score_state == "stale":
            self.repository.mark_stale(job, model.model_version_id)
            return {"status": "stale", "modelVersionId": model.model_version_id}
        if score_state == "leased":
            return {"status": "leased", "modelVersionId": model.model_version_id}
        lease.assert_owned()
        self.result_client.report(job.dispatch, "succeeded", model_reference=model.model_version_id)
        response: dict[str, object] = {"status": "succeeded", "modelVersionId": model.model_version_id, "scoredCustomerCount": scored_count, "scoreBatchIdempotent": score_state == "idempotent"}
        if training_result:
            response["selectedEstimator"] = training_result.selected.estimator_type
            response["selectionReason"] = training_result.selection_reason
            response["splitRanges"] = training_result.split_ranges
            response["metrics"] = {name: candidate.metrics for name, candidate in training_result.candidates.items()}
        return response

    def score_current(self, dispatch: TrainingDispatch) -> dict[str, object]:
        current = self.repository.current_scoring_job(dispatch)
        if not current:
            return {"status": "stale", "trainingRequestId": dispatch.training_request_id}
        job, model = current
        payload = self.artifact_store.get(model.artifact_object_key)
        if artifact_checksum(payload) != model.artifact_checksum:
            raise ArtifactStoreError("persisted artifact checksum mismatch")
        bundle = deserialize_bundle(payload)
        cutoff = utc(self.clock()).replace(hour=0, minute=0, second=0, microsecond=0)
        rows = self.repository.build_scoring_dataset(job, cutoff)
        probabilities = bundle.predict(rows) if rows else np.asarray([], dtype=float)
        count, state = self.repository.persist_scores(job, model, cutoff, rows, probabilities, [bundle.signal_codes(row) for row in rows], self.config.worker_id)
        return {"status": state, "modelVersionId": model.model_version_id, "scoredCustomerCount": count}
