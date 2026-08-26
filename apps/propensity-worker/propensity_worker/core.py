from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Iterable

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

FEATURE_SCHEMA_VERSION = "propensity-v1"
FEATURE_NAMES = ("purchase_count_90d", "purchase_value_90d", "days_since_purchase", "engagement_count_30d")

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
    label: int

class LeakageError(ValueError): pass

def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

def build_snapshot(workspace_id: str, customer_id: str, cutoff: datetime, window_days: int,
                   observations: Iterable[Observation], target_kind: str) -> Snapshot:
    """Builds a bounded row. Every feature observation is checked before aggregation."""
    cutoff = _utc(cutoff); all_rows = tuple(observations)
    for o in all_rows:
        if _utc(o.occurred_at) > cutoff and o.kind.startswith("feature:"):
            raise LeakageError(f"future feature rejected: {o.kind} at {o.occurred_at.isoformat()} > {cutoff.isoformat()}")
    prior = [o for o in all_rows if _utc(o.occurred_at) <= cutoff]
    purchase = [o for o in prior if o.kind == "purchase" and _utc(o.occurred_at) >= cutoff - timedelta(days=90)]
    engagement = [o for o in prior if o.kind == "engagement" and _utc(o.occurred_at) >= cutoff - timedelta(days=30)]
    last_purchase = max((_utc(o.occurred_at) for o in prior if o.kind == "purchase"), default=None)
    days = 999.0 if last_purchase is None else float((cutoff - last_purchase).days)
    horizon = cutoff + timedelta(days=window_days)
    label = int(any(o.kind == target_kind and cutoff < _utc(o.occurred_at) <= horizon for o in all_rows))
    return Snapshot(workspace_id, customer_id, cutoff, (float(len(purchase)), sum(o.value for o in purchase), days, float(len(engagement))), label)

def temporal_split(rows: list[Snapshot]) -> tuple[list[Snapshot], list[Snapshot], list[Snapshot]]:
    ordered = sorted(rows, key=lambda r: (r.cutoff, r.customer_id))
    if len(ordered) < 6: raise ValueError("at least six snapshots are required for temporal split")
    a, b = len(ordered) * 3 // 5, len(ordered) * 4 // 5
    return ordered[:a], ordered[a:b], ordered[b:]

def metrics(y: np.ndarray, p: np.ndarray) -> dict[str, float]:
    return {"roc_auc": float(roc_auc_score(y, p)), "pr_auc": float(average_precision_score(y, p)), "brier": float(brier_score_loss(y, p)), "prevalence": float(y.mean())}

def train(rows: list[Snapshot]) -> tuple[str, object, dict[str, float]]:
    train_rows, calibration_rows, test_rows = temporal_split(rows)
    x = lambda r: np.array([s.values for s in r], dtype=float); y = lambda r: np.array([s.label for s in r], dtype=int)
    if min(sum(s.label for s in rows), len(rows)-sum(s.label for s in rows)) < 1: raise ValueError("insufficient_data")
    candidates = {
        "logistic_regression": CalibratedClassifierCV(LogisticRegression(max_iter=500, random_state=0), method="sigmoid", cv=3),
        "hist_gradient_boosting": CalibratedClassifierCV(HistGradientBoostingClassifier(random_state=0, max_iter=100), method="sigmoid", cv=3),
    }
    selected = None
    for name, model in candidates.items():
        model.fit(x(train_rows + calibration_rows), y(train_rows + calibration_rows))
        score = metrics(y(test_rows), np.clip(model.predict_proba(x(test_rows))[:, 1], 0, 1))
        if selected is None or (score["roc_auc"] > selected[2]["roc_auc"] and score["brier"] <= selected[2]["brier"] + .02): selected = (name, model, score)
    assert selected
    return selected

def artifact_checksum(payload: bytes) -> str: return sha256(payload).hexdigest()

def reason_codes(values: tuple[float, ...]) -> list[str]:
    pairs = sorted(zip(FEATURE_NAMES, values), key=lambda x: abs(x[1]), reverse=True)[:3]
    mapping = {"purchase_count_90d":"high_purchase_frequency", "purchase_value_90d":"recent_purchase_activity", "days_since_purchase":"long_time_since_purchase", "engagement_count_30d":"recent_email_engagement"}
    return [mapping[name] for name, _ in pairs]
