from datetime import datetime, timedelta, timezone
import unittest

import numpy as np

from propensity_worker.core import (
    FEATURE_NAMES, FEATURE_SCHEMA_VERSION, InsufficientDataError, LeakageError,
    MinimumDataPolicy, Observation, artifact_checksum, build_snapshot,
    deserialize_bundle, reason_codes, serialize_bundle, temporal_split, train,
)

T = datetime(2026, 1, 1, tzinfo=timezone.utc)


def synthetic_rows(count=120):
    rows = []
    for index in range(count):
        cutoff = T + timedelta(days=index)
        positive = index % 2 == 1
        events = [Observation(str(index), "purchase", cutoff - timedelta(days=1), 100 if positive else 1)] if positive else []
        if positive: events.append(Observation(str(index), "target", cutoff + timedelta(days=2)))
        rows.append(build_snapshot("workspace-a", str(index), cutoff, 7, events, "target"))
    return rows


class PropensityCoreTests(unittest.TestCase):
    def test_point_in_time_open_closed_window_and_future_lineage(self):
        base = [Observation("c", "purchase", T - timedelta(days=1), 10)]
        at_cutoff = build_snapshot("a", "c", T, 7, base + [Observation("c", "target", T)], "target")
        at_horizon = build_snapshot("a", "c", T, 7, base + [Observation("c", "target", T + timedelta(days=7))], "target")
        after_horizon = build_snapshot("a", "c", T, 7, base + [Observation("c", "target", T + timedelta(days=7, seconds=1))], "target")
        self.assertEqual((at_cutoff.label, at_horizon.label, after_horizon.label), (0, 1, 0))
        with self.assertRaises(LeakageError):
            build_snapshot("a", "c", T, 7, base + [Observation("c", "feature:future_target", T + timedelta(seconds=1))], "target")

    def test_feature_schema_is_bounded_provider_neutral_and_missing_is_deterministic(self):
        forbidden = ("email", "phone", "name", "address", "provider", "access_token")
        self.assertEqual(FEATURE_SCHEMA_VERSION, "propensity-v1")
        self.assertEqual(len(FEATURE_NAMES), 11)
        self.assertFalse(any(term in feature for term in forbidden for feature in FEATURE_NAMES))
        empty = build_snapshot("a", "c", T, 7, [], "target", with_label=False)
        self.assertEqual(empty.values, (0.0, 0.0, 999.0, 0.0, 0.0, 999.0, 0.0, 999.0, 0.0, 0.0, 0.0))
        complete = build_snapshot("a", "c", T, 7, [
            Observation("c", "purchase", T - timedelta(days=2), 42),
            Observation("c", "target", T - timedelta(days=3)),
            Observation("c", "outcome", T - timedelta(days=4)),
            Observation("c", "engagement", T - timedelta(days=1)),
            Observation("c", "subscription_active", T - timedelta(days=5)),
            Observation("c", "crm_open", T - timedelta(days=6)),
            Observation("c", "acquisition_known", T - timedelta(days=7)),
        ], "target", with_label=False)
        self.assertEqual(complete.values, (1.0, 42.0, 2.0, 1.0, 1.0, 3.0, 1.0, 1.0, 1.0, 1.0, 1.0))

    def test_realized_policy_and_strict_temporal_split(self):
        rows = synthetic_rows(120)
        train_rows, calibration_rows, test_rows = temporal_split(rows)
        self.assertEqual((len(train_rows), len(calibration_rows), len(test_rows)), (72, 24, 24))
        self.assertLess(max(row.cutoff for row in train_rows), min(row.cutoff for row in calibration_rows))
        self.assertLess(max(row.cutoff for row in calibration_rows), min(row.cutoff for row in test_rows))
        with self.assertRaises(InsufficientDataError) as error:
            train(rows[:20], MinimumDataPolicy(21, 1, 1))
        self.assertEqual(error.exception.blockers, ["insufficient_labeled_examples"])

    def test_both_candidates_calibrate_evaluate_select_and_reload(self):
        result = train(synthetic_rows(), MinimumDataPolicy(100, 40, 40))
        self.assertEqual(set(result.candidates), {"logistic_regression", "hist_gradient_boosting"})
        self.assertIn(result.selected.estimator_type, result.candidates)
        for candidate in result.candidates.values():
            self.assertEqual(candidate.calibration_method, "sigmoid_platt_on_temporal_calibration")
            self.assertEqual(set(candidate.metrics) & {"roc_auc", "pr_auc", "brier", "prevalence"}, {"roc_auc", "pr_auc", "brier", "prevalence"})
            self.assertEqual(set(candidate.metrics["thresholds"]), {"0.3", "0.5", "0.7"})
        payload = serialize_bundle(result.selected.bundle)
        reloaded = deserialize_bundle(payload)
        smoke = synthetic_rows(20)[-5:]
        probabilities = reloaded.predict(smoke)
        self.assertTrue(np.all((probabilities >= 0) & (probabilities <= 1)))
        self.assertTrue(np.allclose(probabilities, result.selected.bundle.predict(smoke)))
        self.assertEqual(len(artifact_checksum(payload)), 64)
        codes = reason_codes(smoke[0].values)
        self.assertLessEqual(len(codes), 3)
        self.assertFalse(any(term in code for code in codes for term in ("email_address", "phone", "name", "cause", "increase_conversion")))
        self.assertEqual(reloaded.signal_codes(smoke[0]), reloaded.signal_codes(smoke[0]))


if __name__ == "__main__": unittest.main()
