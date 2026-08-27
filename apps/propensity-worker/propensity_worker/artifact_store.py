"""Provider-neutral model artifact store with a private Supabase adapter."""
from __future__ import annotations

from dataclasses import dataclass
import json
from hashlib import sha256
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class ArtifactStoreError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArtifactStat:
    provider: str
    bucket: str
    object_key: str
    size: int
    checksum: str | None = None

    @property
    def reference(self) -> str:
        return f"supabase://{self.bucket}/{self.object_key}"


class ArtifactStore(Protocol):
    def put(self, object_key: str, payload: bytes, checksum: str) -> ArtifactStat: ...
    def get(self, object_key: str) -> bytes: ...
    def head(self, object_key: str) -> ArtifactStat: ...
    def put_and_verify(self, object_key: str, payload: bytes, checksum: str) -> ArtifactStat: ...


def model_object_key(workspace_id: str, radar_id: str, definition_version: int, model_version_id: str) -> str:
    values = (workspace_id, radar_id, model_version_id)
    if any(not value or "/" in value or ".." in value for value in values) or definition_version < 1:
        raise ArtifactStoreError("invalid artifact namespace")
    return f"workspaces/{workspace_id}/radars/{radar_id}/definitions/{definition_version}/models/{model_version_id}/model.joblib"


class SupabaseStorageArtifactStore:
    """Uses Supabase's authenticated Storage REST contract; bucket must pre-exist and be private."""

    def __init__(self, base_url: str, service_role_key: str, bucket: str, timeout_seconds: int = 20, api_prefix: str = "/storage/v1"):
        if not base_url.startswith(("http://", "https://")) or not service_role_key or not bucket or "/" in bucket:
            raise ArtifactStoreError("invalid Supabase Storage configuration")
        self.base_url = base_url.rstrip("/")
        self._key = service_role_key
        self.bucket = bucket
        self.timeout_seconds = timeout_seconds
        self.api_prefix = "/" + api_prefix.strip("/") if api_prefix.strip("/") else ""
        self._assert_private_bucket()

    def _request(self, method: str, path: str, payload: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
        request_headers = {"Authorization": f"Bearer {self._key}", "apikey": self._key, **(headers or {})}
        request = Request(f"{self.base_url}{self.api_prefix}/{path}", data=payload, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return response.read(), {key.lower(): value for key, value in response.headers.items()}
        except (HTTPError, URLError, TimeoutError) as error:
            status = getattr(error, "code", "unavailable")
            raise ArtifactStoreError(f"Supabase Storage request failed ({status})") from None

    def _assert_private_bucket(self) -> None:
        body, _ = self._request("GET", f"bucket/{quote(self.bucket, safe='')}")
        try:
            metadata = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ArtifactStoreError("Supabase Storage bucket metadata invalid") from None
        if metadata.get("public") is not False:
            raise ArtifactStoreError("propensity artifact bucket must be private")

    def _object_path(self, object_key: str) -> str:
        if object_key.startswith("/") or ".." in object_key.split("/"):
            raise ArtifactStoreError("invalid artifact object key")
        return f"object/{quote(self.bucket, safe='')}/{quote(object_key, safe='/')}"

    def put(self, object_key: str, payload: bytes, checksum: str) -> ArtifactStat:
        if sha256(payload).hexdigest() != checksum:
            raise ArtifactStoreError("artifact checksum does not match payload")
        self._request("POST", self._object_path(object_key), payload, {
            "Content-Type": "application/octet-stream",
            "x-upsert": "false",
            "x-truvo-sha256": checksum,
        })
        return ArtifactStat("supabase_storage", self.bucket, object_key, len(payload), checksum)

    def get(self, object_key: str) -> bytes:
        body, _ = self._request("GET", self._object_path(object_key))
        return body

    def head(self, object_key: str) -> ArtifactStat:
        _, headers = self._request("HEAD", self._object_path(object_key))
        size = int(headers.get("content-length", "0"))
        return ArtifactStat("supabase_storage", self.bucket, object_key, size, headers.get("x-truvo-sha256"))

    def put_and_verify(self, object_key: str, payload: bytes, checksum: str) -> ArtifactStat:
        try:
            written = self.put(object_key, payload, checksum)
        except ArtifactStoreError as error:
            if "(409)" not in str(error):
                raise
            written = ArtifactStat("supabase_storage", self.bucket, object_key, len(payload), checksum)
        stat = self.head(object_key)
        readback = self.get(object_key)
        if stat.size != len(payload) or sha256(readback).hexdigest() != checksum or readback != payload:
            raise ArtifactStoreError("artifact write/readback verification failed")
        return written
