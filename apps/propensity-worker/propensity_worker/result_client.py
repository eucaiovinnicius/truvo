from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .contracts import TrainingDispatch


class ResultBoundaryError(RuntimeError):
    pass


class RadarResultClient:
    def __init__(self, api_url: str, internal_secret: str, timeout_seconds: int = 15):
        if not api_url.startswith(("http://", "https://")) or not internal_secret:
            raise ResultBoundaryError("invalid internal Radar result configuration")
        self.api_url = api_url.rstrip("/")
        self._secret = internal_secret
        self.timeout_seconds = timeout_seconds

    def report(self, dispatch: TrainingDispatch, status: str, *, model_reference: str | None = None,
               failure_category: str | None = None, failure_reason: str | None = None) -> None:
        payload = {"status": status}
        if model_reference is not None: payload["modelReference"] = model_reference
        if failure_category is not None: payload["failureCategory"] = failure_category
        if failure_reason is not None: payload["failureReason"] = failure_reason[:500]
        path = "/v1/internal/radars/{}/definitions/{}/training-requests/{}/result".format(
            quote(dispatch.radar_id, safe=""), dispatch.definition_version, quote(dispatch.training_request_id, safe=""))
        request = Request(
            self.api_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", "x-internal-secret": self._secret, "x-workspace-id": dispatch.workspace_id},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                if response.status != 200: raise ResultBoundaryError(f"Radar result boundary returned {response.status}")
        except (HTTPError, URLError, TimeoutError) as error:
            raise ResultBoundaryError(f"Radar result boundary unavailable ({getattr(error, 'code', 'network')})") from None
