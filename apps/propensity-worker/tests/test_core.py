from datetime import datetime, timedelta, timezone
import unittest
from propensity_worker.core import Observation, LeakageError, build_snapshot, temporal_split, train, reason_codes

T = datetime(2026, 1, 1, tzinfo=timezone.utc)
class PropensityTests(unittest.TestCase):
 def test_open_closed_label_window_and_leakage(self):
  rows=[Observation("c","purchase",T-timedelta(days=1),10),Observation("c","target",T),Observation("c","target",T+timedelta(days=7))]
  self.assertEqual(build_snapshot("a","c",T,7,rows,"target").label,1)
  with self.assertRaises(LeakageError): build_snapshot("a","c",T,7,rows+[Observation("c","feature:future",T+timedelta(seconds=1))],"target")
 def test_temporal_train_and_reasons(self):
  rows=[]
  for i in range(30):
   t=T+timedelta(days=i); rows.append(build_snapshot("a",str(i),t,7,[Observation(str(i),"purchase",t-timedelta(days=1),i),Observation(str(i),"target",t+timedelta(days=2))] if i%2 else [Observation(str(i),"purchase",t-timedelta(days=2),i)],"target"))
  a,b,c=temporal_split(rows); self.assertLess(max(x.cutoff for x in a), min(x.cutoff for x in c)); name,model,m=train(rows); self.assertIn(name,{"logistic_regression","hist_gradient_boosting"}); self.assertGreaterEqual(m["brier"],0); self.assertIn("high_purchase_frequency",reason_codes((2,1,0,0)))
if __name__ == '__main__': unittest.main()
