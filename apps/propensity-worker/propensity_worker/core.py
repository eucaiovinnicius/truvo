"""Point-in-time feature construction and calibrated estimator contract.

This module is intentionally storage/transport agnostic. The production runtime in
``runtime.py`` is the only layer allowed to join it to Postgres and Supabase.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
from typing import Iterable, cast

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, precision_score, recall_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

FEATURE_SCHEMA_VERSION = "propensity-v1"
SERIALIZATION_FORMAT = "joblib-v1"
FEATURE_NAMES = (
    "purchase_count_90d",
    "purchase_value_90d",
    "days_since_purchase",
    "target_outcome_count_180d",
    "non_target_outcome_count_180d",
    "days_since_outcome",
    "engagement_count_30d",
    "days_since_engagement",
    "active_subscription_count",
    "crm_open_deal_count",
    "acquisition_context_known",
)
SIGNAL_CODE_BY_FEATURE = {
    "purchase_count_90d": "high_purchase_frequency",
    "purchase_value_90d": "recent_purchase_activity",
    "days_since_purchase": "long_time_since_purchase",
    "target_outcome_count_180d": "prior_target_activity",
    "non_target_outcome_count_180d": "recent_customer_activity",
    "days_since_outcome": "long_time_since_outcome",
    "engagement_count_30d": "recent_email_engagement",
    "days_since_engagement": "long_time_since_engagement",
    "active_subscription_count": "active_subscription_signal",
    "crm_open_deal_count": "open_crm_relationship_signal",
    "acquisition_context_known": "known_acquisition_context",
}


@dataclass(frozen=True)
class MinimumDataPolicy:
    min_labeled_examples: int = 1_000
    min_positives: int = 100
    min_negatives: int = 100


@dataclass(frozen=True)
class Observation:
    customer_id: str
    kind: str
    occurred_at: datetime
    value: float = 1.0


@dataclass(frozen=True)
class Snapshot:
    workspace_id: str
    customer_id: str
    cutoff: datetime
    values: tuple[float, ...]
    label: int | None
    feature_schema_version: str = FEATURE_SCHEMA_VERSION


@dataclass(frozen=True)
class SplitSummary:
    name: str
    start: str
    end: str
    rows: int
    positives: int
    negatives: int


@dataclass
class ModelBundle:
    estimator_type: str
    estimator: object
    feature_schema_version: str
    feature_names: tuple[str, ...]

    def predict(self, rows: list[Snapshot]) -> np.ndarray:
        if any(row.feature_schema_version != self.feature_schema_version for row in rows):
            raise ValueError("feature_schema_version_mismatch")
        matrix = np.asarray([row.values for row in rows], dtype=float)
        return np.clip(self.estimator.predict_proba(matrix)[:, 1], 0.0, 1.0)  # type: ignore[attr-defined]

    def signal_codes(self, row: Snapshot, limit: int = 3) -> list[str]:
        """Stable one-feature perturbation attribution; signals are explicitly non-causal."""
        original = float(self.predict([row])[0])
        impacts: list[tuple[float, str]] = []
        recency_features = {"days_since_purchase", "days_since_outcome", "days_since_engagement"}
        for index, feature in enumerate(self.feature_names):
            counterfactual = list(row.values)
            counterfactual[index] = 999.0 if feature in recency_features else 0.0
            changed = Snapshot(row.workspace_id, row.customer_id, row.cutoff, tuple(counterfactual), None, row.feature_schema_version)
            impacts.append((abs(original - float(self.predict([changed])[0])), feature))
        impacts.sort(key=lambda item: (-item[0], item[1]))
        return [SIGNAL_CODE_BY_FEATURE[feature] for _, feature in impacts[:limit]]


@dataclass
class CandidateEvaluation:
    estimator_type: str
    metrics: dict[str, object]
    calibration_method: str
    bundle: ModelBundle


@dataclass
class TrainingResult:
    selected: CandidateEvaluation
    candidates: dict[str, CandidateEvaluation]
    selection_reason: str
    split_ranges: dict[str, dict[str, object]]
    data_counts: dict[str, int]


class LeakageError(ValueError):
    """Raised when a feature lineage timestamp exceeds its snapshot cutoff."""


class InsufficientDataError(ValueError):
    def __init__(self, counts: dict[str, int], blockers: list[str]):
        super().__init__("insufficient_data:" + ",".join(blockers))
        self.counts = counts
        self.blockers = blockers


def utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _recency(cutoff: datetime, rows: list[Observation], missing: float = 999.0) -> float:
    latest = max((utc(row.occurred_at) for row in rows), default=None)
    return missing if latest is None else max(0.0, (cutoff - latest).total_seconds() / 86_400)


def build_snapshot(
    workspace_id: str,
    customer_id: str,
    cutoff: datetime,
    window_days: int,
    observations: Iterable[Observation],
    target_kind: str,
    *,
    with_label: bool = True,
) -> Snapshot:
    """Build one customer-at-cutoff row using a bounded, PII-free schema.

    Raw future facts may be present because they are required to build the label;
    they are excluded from every feature. Explicit ``feature:*`` observations are
    precomputed feature lineage and therefore fail closed when timestamped after t.
    """
    cutoff = utc(cutoff)
    all_rows = tuple(observations)
    leaking = [row for row in all_rows if row.kind.startswith("feature:") and utc(row.occurred_at) > cutoff]
    if leaking:
        row = min(leaking, key=lambda value: utc(value.occurred_at))
        raise LeakageError(f"future feature rejected: {row.kind} at {utc(row.occurred_at).isoformat()} > {cutoff.isoformat()}")

    prior = [row for row in all_rows if utc(row.occurred_at) <= cutoff]
    purchases = [row for row in prior if row.kind == "purchase"]
    purchases_90d = [row for row in purchases if utc(row.occurred_at) >= cutoff - timedelta(days=90)]
    target_prior = [row for row in prior if row.kind == target_kind]
    target_180d = [row for row in target_prior if utc(row.occurred_at) >= cutoff - timedelta(days=180)]
    non_target_180d = [row for row in prior if row.kind == "outcome" and utc(row.occurred_at) >= cutoff - timedelta(days=180)]
    engagements = [row for row in prior if row.kind == "engagement"]
    engagement_30d = [row for row in engagements if utc(row.occurred_at) >= cutoff - timedelta(days=30)]
    active_subscriptions = [row for row in prior if row.kind == "subscription_active"]
    open_deals = [row for row in prior if row.kind == "crm_open"]
    acquisition = [row for row in prior if row.kind == "acquisition_known"]

    values = (
        float(len(purchases_90d)),
        float(sum(row.value for row in purchases_90d)),
        _recency(cutoff, purchases),
        float(len(target_180d)),
        float(len(non_target_180d)),
        _recency(cutoff, target_prior + non_target_180d),
        float(len(engagement_30d)),
        _recency(cutoff, engagements),
        float(len(active_subscriptions)),
        float(len(open_deals)),
        float(bool(acquisition)),
    )
    label: int | None = None
    if with_label:
        horizon = cutoff + timedelta(days=window_days)
        label = int(any(row.kind == target_kind and cutoff < utc(row.occurred_at) <= horizon for row in all_rows))
    return Snapshot(workspace_id, customer_id, cutoff, values, label)


def temporal_split(rows: list[Snapshot]) -> tuple[list[Snapshot], list[Snapshot], list[Snapshot]]:
    ordered = sorted(rows, key=lambda row: (utc(row.cutoff), row.customer_id))
    if len(ordered) < 10:
        raise ValueError("at least ten snapshots are required for temporal split")
    cutoffs = sorted({utc(row.cutoff) for row in ordered})
    if len(cutoffs) < 5:
        raise InsufficientDataError({"rows": len(rows), "positives": sum(int(row.label or 0) for row in rows), "negatives": sum(int(not row.label) for row in rows)}, ["insufficient_distinct_temporal_cutoffs"])
    calibration_start = cutoffs[max(1, len(cutoffs) * 3 // 5)]
    test_start = cutoffs[max(2, len(cutoffs) * 4 // 5)]
    train_rows = [row for row in ordered if utc(row.cutoff) < calibration_start]
    calibration_rows = [row for row in ordered if calibration_start <= utc(row.cutoff) < test_start]
    test_rows = [row for row in ordered if utc(row.cutoff) >= test_start]
    if not train_rows or not calibration_rows or not test_rows or not (max(row.cutoff for row in train_rows) < min(row.cutoff for row in calibration_rows) < min(row.cutoff for row in test_rows)):
        raise LeakageError("temporal split ordering failed")
    return train_rows, calibration_rows, test_rows


def _binary(rows: list[Snapshot]) -> np.ndarray:
    if any(row.label is None for row in rows):
        raise ValueError("labeled snapshots required")
    return np.asarray([cast(int, row.label) for row in rows], dtype=int)


def _matrix(rows: list[Snapshot]) -> np.ndarray:
    return np.asarray([row.values for row in rows], dtype=float)


def _calibration_buckets(y: np.ndarray, probabilities: np.ndarray) -> list[dict[str, float | int]]:
    buckets: list[dict[str, float | int]] = []
    for lower in np.linspace(0, 0.9, 10):
        upper = lower + 0.1
        mask = (probabilities >= lower) & (probabilities <= upper if upper >= 1 else probabilities < upper)
        if not mask.any():
            continue
        buckets.append({"lower": round(float(lower), 2), "upper": round(float(upper), 2), "count": int(mask.sum()), "mean_probability": float(probabilities[mask].mean()), "observed_rate": float(y[mask].mean())})
    return buckets


def evaluate(y: np.ndarray, probabilities: np.ndarray) -> dict[str, object]:
    if len(np.unique(y)) != 2:
        raise InsufficientDataError({"rows": len(y), "positives": int(y.sum()), "negatives": int(len(y) - y.sum())}, ["temporal_partition_missing_class"])
    threshold_summaries: dict[str, dict[str, float]] = {}
    for threshold in (0.3, 0.5, 0.7):
        predicted = probabilities >= threshold
        threshold_summaries[str(threshold)] = {
            "precision": float(precision_score(y, predicted, zero_division=0)),
            "recall": float(recall_score(y, predicted, zero_division=0)),
        }
    return {
        "roc_auc": float(roc_auc_score(y, probabilities)),
        "pr_auc": float(average_precision_score(y, probabilities)),
        "brier": float(brier_score_loss(y, probabilities)),
        "prevalence": float(y.mean()),
        "thresholds": threshold_summaries,
        "calibration_buckets": _calibration_buckets(y, probabilities),
    }


def _split_summary(name: str, rows: list[Snapshot]) -> SplitSummary:
    labels = _binary(rows)
    return SplitSummary(name, min(row.cutoff for row in rows).isoformat(), max(row.cutoff for row in rows).isoformat(), len(rows), int(labels.sum()), int(len(labels) - labels.sum()))


def _fit_candidate(name: str, base: object, train_rows: list[Snapshot], calibration_rows: list[Snapshot], test_rows: list[Snapshot]) -> CandidateEvaluation:
    base.fit(_matrix(train_rows), _binary(train_rows))  # type: ignore[attr-defined]
    calibrated = CalibratedClassifierCV(base, method="sigmoid", cv="prefit")
    calibrated.fit(_matrix(calibration_rows), _binary(calibration_rows))
    probabilities = np.clip(calibrated.predict_proba(_matrix(test_rows))[:, 1], 0.0, 1.0)
    return CandidateEvaluation(name, evaluate(_binary(test_rows), probabilities), "sigmoid_platt_on_temporal_calibration", ModelBundle(name, calibrated, FEATURE_SCHEMA_VERSION, FEATURE_NAMES))


def train(rows: list[Snapshot], policy: MinimumDataPolicy = MinimumDataPolicy()) -> TrainingResult:
    counts = {"rows": len(rows), "positives": sum(int(row.label or 0) for row in rows)}
    counts["negatives"] = counts["rows"] - counts["positives"]
    blockers = []
    if counts["rows"] < policy.min_labeled_examples: blockers.append("insufficient_labeled_examples")
    if counts["positives"] < policy.min_positives: blockers.append("insufficient_positive_outcomes")
    if counts["negatives"] < policy.min_negatives: blockers.append("insufficient_negative_examples")
    if blockers:
        raise InsufficientDataError(counts, blockers)

    train_rows, calibration_rows, test_rows = temporal_split(rows)
    for name, partition in (("train", train_rows), ("calibration", calibration_rows), ("test", test_rows)):
        labels = _binary(partition)
        if len(np.unique(labels)) != 2:
            raise InsufficientDataError(counts, [f"{name}_partition_missing_class"])

    candidates = {
        "logistic_regression": _fit_candidate(
            "logistic_regression",
            Pipeline([("scale", StandardScaler()), ("model", LogisticRegression(max_iter=500, random_state=0))]),
            train_rows, calibration_rows, test_rows,
        ),
        "hist_gradient_boosting": _fit_candidate(
            "hist_gradient_boosting",
            HistGradientBoostingClassifier(random_state=0, max_iter=100, max_leaf_nodes=15),
            train_rows, calibration_rows, test_rows,
        ),
    }
    baseline = candidates["logistic_regression"]
    nonlinear = candidates["hist_gradient_boosting"]
    metric = lambda candidate, name: float(cast(float, candidate.metrics[name]))
    baseline_healthy = metric(baseline, "roc_auc") >= 0.5 and metric(baseline, "brier") <= 0.25
    nonlinear_healthy = metric(nonlinear, "roc_auc") >= 0.5 and metric(nonlinear, "brier") <= 0.25
    if nonlinear_healthy and (
        not baseline_healthy
        or (metric(nonlinear, "roc_auc") >= metric(baseline, "roc_auc") + 0.01
            and metric(nonlinear, "brier") <= metric(baseline, "brier") + 0.02)
    ):
        selected, reason = nonlinear, "nonlinear_improved_auc_without_material_calibration_degradation"
    elif baseline_healthy:
        selected, reason = baseline, "calibrated_baseline_retained_no_safe_nonlinear_improvement"
    else:
        raise ValueError("no_healthy_candidate")
    summaries = {name: asdict(_split_summary(name, partition)) for name, partition in (("train", train_rows), ("calibration", calibration_rows), ("test", test_rows))}
    return TrainingResult(selected, candidates, reason, summaries, counts)


def serialize_bundle(bundle: ModelBundle) -> bytes:
    buffer = BytesIO()
    joblib.dump({"serialization_format": SERIALIZATION_FORMAT, "bundle": bundle}, buffer, compress=3)
    return buffer.getvalue()


def deserialize_bundle(payload: bytes) -> ModelBundle:
    envelope = joblib.load(BytesIO(payload))
    if not isinstance(envelope, dict) or envelope.get("serialization_format") != SERIALIZATION_FORMAT or not isinstance(envelope.get("bundle"), ModelBundle):
        raise ValueError("unsupported_model_artifact")
    return envelope["bundle"]


def artifact_checksum(payload: bytes) -> str:
    return sha256(payload).hexdigest()


def reason_codes(values: tuple[float, ...]) -> list[str]:
    ranked = sorted(zip(FEATURE_NAMES, values), key=lambda pair: (-abs(pair[1]), pair[0]))[:3]
    return [SIGNAL_CODE_BY_FEATURE[name] for name, _ in ranked]
