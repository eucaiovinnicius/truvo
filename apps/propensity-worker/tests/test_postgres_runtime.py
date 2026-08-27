from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
import unittest
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from propensity_worker.artifact_store import SupabaseStorageArtifactStore
from propensity_worker.contracts import TrainingDispatch
from propensity_worker.repository import PostgresRepository
from propensity_worker.runtime import PropensityRuntime, WorkerConfig
from tests import test_artifact_store as artifact_fixture

NOW = datetime(2026, 1, 1, 12, 34, tzinfo=timezone.utc)


class DatabaseResultClient:
    """Test boundary stops at validated; promotion is an explicit registry operation."""
    def __init__(self, database_url): self.database_url = database_url; self.calls = []
    def report(self, dispatch, status, **values):
        self.calls.append((dispatch.workspace_id, status, values))
        with psycopg.connect(self.database_url) as connection, connection.transaction():
            if status == "succeeded":
                model = values["model_reference"]
                connection.execute("update radar_training_requests set status='succeeded',model_reference=%s,terminal_at=now(),claimed_by=null,lease_expires_at=null where workspace_id=%s and id=%s", (model, dispatch.workspace_id, dispatch.training_request_id))
                connection.execute("update radar_model_versions set status='validated' where workspace_id=%s and id=%s", (dispatch.workspace_id, model))
                connection.execute("update radars set status='ready_to_train' where workspace_id=%s and id=%s and current_definition_version=%s", (dispatch.workspace_id, dispatch.radar_id, dispatch.definition_version))
            else:
                old = connection.execute("select current_model_reference from radars where workspace_id=%s and id=%s", (dispatch.workspace_id, dispatch.radar_id)).fetchone()[0]
                connection.execute("update radar_training_requests set status=%s,failure_category=%s,failure_reason=%s,terminal_at=now(),claimed_by=null,lease_expires_at=null where workspace_id=%s and id=%s", (status, values.get("failure_category"), values.get("failure_reason"), dispatch.workspace_id, dispatch.training_request_id))
                connection.execute("update radars set status=%s where workspace_id=%s and id=%s", ("active" if old else ("insufficient_data" if status == "insufficient_data" else "failed"), dispatch.workspace_id, dispatch.radar_id))


class PostgresRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database_url = os.environ["DATABASE_URL"]
        artifact_fixture.ArtifactStoreTests.setUpClass()
        cls.storage_url = artifact_fixture.ArtifactStoreTests.url
    @classmethod
    def tearDownClass(cls): artifact_fixture.ArtifactStoreTests.tearDownClass()
    def setUp(self):
        artifact_fixture.StorageHandler.objects = {}; artifact_fixture.StorageHandler.public = False; artifact_fixture.StorageHandler.authorization = []
        self.ws_a = str(uuid4()); self.ws_b = str(uuid4())
        with psycopg.connect(self.database_url) as connection:
            for workspace, slug in ((self.ws_a, "a" + self.ws_a[:8]), (self.ws_b, "b" + self.ws_b[:8])):
                connection.execute("insert into workspaces (id,name,slug) values (%s,%s,%s)", (workspace, "Propensity runtime", slug))
                connection.execute("insert into outcome_definitions (workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values (%s,'target','canonical','purchase','Purchase','event','{}','runtime')", (workspace,))
    def _radar_request(self, workspace, suffix="main", version=1, status="training"):
        radar = f"rad-{suffix}"; request = f"req-{suffix}"; correlation = f"corr-{suffix}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute("insert into radars (workspace_id,id,name,status,current_definition_version) values (%s,%s,%s,%s,%s)", (workspace, radar, suffix, status, version))
            connection.execute("insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,readiness) values (%s,%s,%s,'target',%s,7,'{}','{}')", (workspace, radar, version, Jsonb({"version": 1, "op": "identified"})))
            connection.execute("insert into radar_training_requests (workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values (%s,%s,%s,%s,%s,'accepted',%s)", (workspace, request, radar, version, f"key-{suffix}", correlation))
        return TrainingDispatch(workspace, radar, version, request, correlation)
    def _customers(self, workspace, count=30):
        first = NOW - timedelta(days=210)
        with psycopg.connect(self.database_url) as connection:
            for index in range(count):
                customer = f"customer-{index:03d}"
                connection.execute("insert into customers (workspace_id,id,status,source_namespace,first_seen_at,last_seen_at) values (%s,%s,'identified','runtime',%s,%s)", (workspace, customer, first, NOW))
                if index % 2:
                    for week in range(31):
                        observed = first + timedelta(days=week * 7 + 3)
                        connection.execute("insert into customer_outcomes (workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,source_namespace,observed_at) values (%s,%s,%s,'target','canonical','purchase',%s,%s,'runtime',%s)", (workspace, f"out-{index}-{week}", customer, f"dedupe-{index}-{week}", f"event-{index}-{week}", observed))
    def test_atomic_claim_duplicate_delivery_expiry_and_tenant_isolation(self):
        dispatch = self._radar_request(self.ws_a, "lease")
        repository = PostgresRepository(self.database_url)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda index: repository.claim_training(dispatch, f"worker-{index}", 300).state, range(8)))
        self.assertEqual(results.count("claimed"), 1); self.assertEqual(results.count("leased"), 7)
        self.assertEqual(repository.claim_training(TrainingDispatch(self.ws_b, dispatch.radar_id, 1, dispatch.training_request_id, dispatch.correlation_id), "intruder", 300).state, "not_found")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("update radar_training_requests set lease_expires_at=now()-interval '1 second' where workspace_id=%s and id=%s", (self.ws_a, dispatch.training_request_id))
        recovered = repository.claim_training(dispatch, "recovery-worker", 300)
        self.assertEqual((recovered.state, recovered.job.attempt_count), ("claimed", 2))
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            row = connection.execute("select count(*)::int as count,attempt_count from radar_training_requests where workspace_id=%s and id=%s group by attempt_count", (self.ws_a, dispatch.training_request_id)).fetchone()
        self.assertEqual((row["count"], row["attempt_count"]), (1, 2))
    def test_stale_request_is_terminal_before_dataset_construction(self):
        dispatch = self._radar_request(self.ws_a, "stale")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,readiness) values (%s,%s,2,'target',%s,14,'{}','{}')", (self.ws_a, dispatch.radar_id, Jsonb({"version": 1, "op": "identified"})))
            connection.execute("update radars set current_definition_version=2,status='draft' where workspace_id=%s and id=%s", (self.ws_a, dispatch.radar_id))
        self.assertEqual(PostgresRepository(self.database_url).claim_training(dispatch, "worker", 300).state, "stale")
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("select status from radar_training_requests where workspace_id=%s and id=%s", (self.ws_a, dispatch.training_request_id)).fetchone()[0], "superseded")
            self.assertEqual(connection.execute("select count(*) from radar_model_versions where workspace_id=%s", (self.ws_a,)).fetchone()[0], 0)
    def test_migration_claim_model_score_constraints_exist(self):
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            indexes = {row["indexname"] for row in connection.execute("select indexname from pg_indexes where schemaname='public' and tablename in ('radar_training_requests','radar_model_versions','radar_score_batches')")}
            foreign_keys = {row["conname"] for row in connection.execute("select conname from pg_constraint where contype='f' and conrelid in ('radar_model_versions'::regclass,'radar_propensity_scores'::regclass,'radar_score_batches'::regclass)")}
            columns = {row["column_name"] for row in connection.execute("select column_name from information_schema.columns where table_schema='public' and table_name='radar_training_requests'")}
        self.assertTrue({'claimed_by', 'claimed_at', 'lease_expires_at', 'attempt_count', 'terminal_at'} <= columns)
        self.assertIn('radar_training_requests_claimable_idx', indexes); self.assertNotIn('radar_training_requests_one_per_definition_uq', indexes)
        self.assertTrue(any('radar_propensity_scores' in name and 'customers' in name for name in foreign_keys))
    def test_end_to_end_artifact_model_scoring_refresh_and_idempotency(self):
        dispatch = self._radar_request(self.ws_a, "e2e"); self._customers(self.ws_a); self._customers(self.ws_b, 1)
        repository = PostgresRepository(self.database_url); boundary = DatabaseResultClient(self.database_url)
        runtime = PropensityRuntime(repository, SupabaseStorageArtifactStore(self.storage_url, "service-role", "models"), boundary, WorkerConfig("worker-e2e", 300, 100, 40, 40), clock=lambda: NOW)
        result = runtime.process(dispatch)
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(result["scoredCustomerCount"], 30)
        self.assertEqual({name: summary["rows"] for name, summary in result["splitRanges"].items()}, {"train": 540, "calibration": 180, "test": 180})
        self.assertIn(result["selectedEstimator"], ("logistic_regression", "hist_gradient_boosting"))
        self.assertEqual(runtime.process(dispatch)["status"], "terminal")
        # Refresh is intentionally unavailable before an explicit registry promotion.
        self.assertEqual(runtime.score_current(dispatch)["status"], "stale")
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            model = connection.execute("select * from radar_model_versions where workspace_id=%s and training_request_id=%s", (self.ws_a, dispatch.training_request_id)).fetchone()
            scores = connection.execute("select count(*)::int as count,min(probability)::float8 as minimum,max(probability)::float8 as maximum,count(distinct scoring_cutoff)::int as batches from radar_propensity_scores where workspace_id=%s and radar_id=%s", (self.ws_a, dispatch.radar_id)).fetchone()
            cross = connection.execute("select count(*) as count from radar_propensity_scores where workspace_id=%s and customer_id='customer-000'", (self.ws_b,)).fetchone()["count"]
        self.assertEqual((model["definition_version"], model["target_outcome_definition_id"], model["feature_schema_version"], model["status"]), (1, "target", "propensity-v1", "validated"))
        self.assertTrue(model["artifact_reference"].startswith("supabase://models/workspaces/")); self.assertNotIn("service-role", model["artifact_reference"])
        self.assertGreaterEqual(scores["minimum"], 0); self.assertLessEqual(scores["maximum"], 1); self.assertEqual(scores["count"], 30); self.assertEqual(scores["batches"], 1); self.assertEqual(cross, 0)
    def test_realized_insufficient_data_writes_no_artifact_model_or_scores(self):
        dispatch = self._radar_request(self.ws_b, "insufficient"); self._customers(self.ws_b, 1)
        boundary = DatabaseResultClient(self.database_url)
        runtime = PropensityRuntime(PostgresRepository(self.database_url), SupabaseStorageArtifactStore(self.storage_url, "service-role", "models"), boundary, WorkerConfig("worker-insufficient", 300, 10, 1, 1), clock=lambda: NOW)
        result = runtime.process(dispatch)
        self.assertEqual(result["status"], "insufficient_data"); self.assertIn("insufficient_positive_outcomes", result["blockers"])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("select count(*) from radar_model_versions where workspace_id=%s", (self.ws_b,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("select count(*) from radar_propensity_scores where workspace_id=%s", (self.ws_b,)).fetchone()[0], 0)
        self.assertEqual(artifact_fixture.StorageHandler.objects, {})
    def test_definition_edit_after_artifact_keeps_historical_model_without_scores(self):
        dispatch = self._radar_request(self.ws_a, "late-stale"); self._customers(self.ws_a)
        database_url = self.database_url
        class RacingRepository(PostgresRepository):
            def persist_model(self, job, model_version_id, result, artifact, verified_at):
                model = super().persist_model(job, model_version_id, result, artifact, verified_at)
                with psycopg.connect(database_url) as connection:
                    connection.execute("insert into radar_definition_versions (workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,readiness) values (%s,%s,2,'target',%s,14,'{}','{}')", (job.dispatch.workspace_id, job.dispatch.radar_id, Jsonb({"version": 1, "op": "identified"})))
                    connection.execute("update radars set current_definition_version=2,status='draft',current_model_reference=null where workspace_id=%s and id=%s", (job.dispatch.workspace_id, job.dispatch.radar_id))
                return model
        boundary = DatabaseResultClient(self.database_url)
        runtime = PropensityRuntime(RacingRepository(self.database_url), SupabaseStorageArtifactStore(self.storage_url, "service-role", "models"), boundary, WorkerConfig("worker-race", 300, 100, 40, 40), clock=lambda: NOW)
        result = runtime.process(dispatch)
        self.assertEqual(result["status"], "stale"); self.assertEqual(boundary.calls, [])
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            radar = connection.execute("select status,current_definition_version,current_model_reference from radars where workspace_id=%s and id=%s", (self.ws_a, dispatch.radar_id)).fetchone()
            model = connection.execute("select status from radar_model_versions where workspace_id=%s and training_request_id=%s", (self.ws_a, dispatch.training_request_id)).fetchone()
            request = connection.execute("select status from radar_training_requests where workspace_id=%s and id=%s", (self.ws_a, dispatch.training_request_id)).fetchone()
            score_count = connection.execute("select count(*) as count from radar_propensity_scores where workspace_id=%s and radar_id=%s", (self.ws_a, dispatch.radar_id)).fetchone()["count"]
        self.assertEqual(dict(radar), {"status": "draft", "current_definition_version": 2, "current_model_reference": None})
        self.assertEqual((model["status"], request["status"], score_count), ("historical", "superseded", 0))


if __name__ == "__main__": unittest.main()
