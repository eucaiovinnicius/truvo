"""Railway-deployable Kafka worker entrypoint."""
from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys

from kafka import KafkaConsumer

from .artifact_store import SupabaseStorageArtifactStore
from .contracts import TrainingDispatch
from .repository import PostgresRepository
from .result_client import RadarResultClient
from .runtime import PropensityRuntime, WorkerConfig


def env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value: raise RuntimeError(f"{name} is required")
    return value


def build_runtime() -> PropensityRuntime:
    return PropensityRuntime(
        PostgresRepository(env("DATABASE_URL")),
        SupabaseStorageArtifactStore(
            env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), env("PROPENSITY_ARTIFACT_BUCKET"),
            api_prefix=os.getenv("SUPABASE_STORAGE_API_PREFIX", "/storage/v1"),
        ),
        RadarResultClient(os.getenv("INTERNAL_API_URL", "http://localhost:3333"), env("INTERNAL_API_SECRET")),
        WorkerConfig(
            os.getenv("PROPENSITY_WORKER_ID", f"{socket.gethostname()}-{os.getpid()}"),
            int(os.getenv("PROPENSITY_LEASE_SECONDS", "300")),
            int(os.getenv("RADAR_MIN_LABELED_EXAMPLES", "1000")),
            int(os.getenv("RADAR_MIN_POSITIVES", "100")),
            int(os.getenv("RADAR_MIN_NEGATIVES", "100")),
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once-json", help="Process exactly one minimal dispatch JSON and exit")
    args = parser.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    runtime = build_runtime()
    if args.once_json:
        print(json.dumps(runtime.process(TrainingDispatch.parse(args.once_json)), default=str, sort_keys=True))
        return 0
    brokers = [value.strip() for value in env("KAFKA_BROKERS").split(",") if value.strip()]
    consumer = KafkaConsumer(
        bootstrap_servers=brokers,
        group_id=os.getenv("PROPENSITY_CONSUMER_GROUP_ID", "truvo-propensity-workers"),
        enable_auto_commit=False,
        auto_offset_reset="earliest",
        value_deserializer=lambda value: value,
    )
    consumer.subscribe([
        os.getenv("PROPENSITY_TRAINING_TOPIC", "truvo.propensity.training"),
        os.getenv("PROPENSITY_SCORING_TOPIC", "truvo.propensity.scoring"),
    ])
    for message in consumer:
        try:
            dispatch = TrainingDispatch.parse(message.value)
            result = runtime.score_current(dispatch) if message.topic == os.getenv("PROPENSITY_SCORING_TOPIC", "truvo.propensity.scoring") else runtime.process(dispatch)
            logging.info("propensity dispatch completed status=%s request=%s", result.get("status"), result.get("trainingRequestId", "durable"))
            consumer.commit()
        except Exception:
            logging.exception("propensity dispatch failed before durable terminal result")
    return 0


if __name__ == "__main__": sys.exit(main())
