# Propensity worker (Order 090)

Isolated Python batch worker. Install with `python -m pip install -r requirements.txt`; test with `python -m unittest discover -s tests -v` (run from this directory). It exposes deterministic point-in-time snapshot, temporal split, calibrated logistic baseline and calibrated histogram-gradient-boosting candidate primitives. Production execution must provide an approved durable artifact-store adapter; local/container files are deliberately not accepted as durable storage.
