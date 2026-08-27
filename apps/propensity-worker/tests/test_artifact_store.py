from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from propensity_worker.artifact_store import ArtifactStoreError, SupabaseStorageArtifactStore, model_object_key


class StorageHandler(BaseHTTPRequestHandler):
    objects = {}
    public = False
    authorization = []
    def log_message(self, *_): pass
    def _auth(self):
        self.__class__.authorization.append(self.headers.get("authorization"))
    def do_GET(self):
        self._auth()
        if self.path.startswith("/storage/v1/bucket/"):
            body = json.dumps({"id": "models", "public": self.__class__.public}).encode(); self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        payload = self.__class__.objects.get(self.path)
        if payload is None: self.send_error(404); return
        self.send_response(200); self.send_header("content-length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def do_POST(self):
        self._auth()
        if self.path in self.__class__.objects: self.send_error(409); return
        payload = self.rfile.read(int(self.headers["content-length"])); self.__class__.objects[self.path] = payload
        self.send_response(200); self.end_headers()
    def do_HEAD(self):
        self._auth(); payload = self.__class__.objects.get(self.path)
        if payload is None: self.send_error(404); return
        self.send_response(200); self.send_header("content-length", str(len(payload))); self.send_header("x-truvo-sha256", sha256(payload).hexdigest()); self.end_headers()


class ArtifactStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StorageHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.thread.join(); cls.server.server_close()
    def setUp(self): StorageHandler.objects = {}; StorageHandler.public = False; StorageHandler.authorization = []
    def test_private_supabase_put_head_readback_checksum_and_namespace(self):
        store = SupabaseStorageArtifactStore(self.url, "server-secret", "models")
        key = model_object_key("ws-a", "rad-a", 2, "mdl-a")
        payload = b"deterministic-model"; checksum = sha256(payload).hexdigest()
        stat = store.put_and_verify(key, payload, checksum)
        self.assertEqual((stat.provider, stat.reference, stat.checksum), ("supabase_storage", f"supabase://models/{key}", checksum))
        self.assertEqual(store.get(key), payload)
        self.assertNotIn("server-secret", stat.reference)
        self.assertTrue(all(value == "Bearer server-secret" for value in StorageHandler.authorization))
        second = store.put_and_verify(key, payload, checksum)
        self.assertEqual(second.reference, stat.reference)
    def test_public_bucket_invalid_namespace_and_corruption_fail_closed(self):
        StorageHandler.public = True
        with self.assertRaisesRegex(ArtifactStoreError, "private"): SupabaseStorageArtifactStore(self.url, "secret", "models")
        StorageHandler.public = False; store = SupabaseStorageArtifactStore(self.url, "secret", "models")
        with self.assertRaises(ArtifactStoreError): model_object_key("../other", "radar", 1, "model")
        with self.assertRaisesRegex(ArtifactStoreError, "checksum"): store.put("valid/key", b"payload", "bad")


if __name__ == "__main__": unittest.main()
