from hashlib import sha256
import os
import unittest

from propensity_worker.artifact_store import SupabaseStorageArtifactStore, model_object_key


class OfficialSupabaseStorageTests(unittest.TestCase):
    def test_private_bucket_real_storage_api_write_stat_readback(self):
        store = SupabaseStorageArtifactStore(
            os.environ["PROPENSITY_STORAGE_TEST_URL"],
            os.environ["PROPENSITY_STORAGE_TEST_SERVICE_KEY"],
            "propensity-models",
            api_prefix="",
        )
        payload = b"real-supabase-storage-api-artifact"
        checksum = sha256(payload).hexdigest()
        key = model_object_key("workspace-official", "radar-official", 1, "model-official")
        stat = store.put_and_verify(key, payload, checksum)
        self.assertEqual(store.get(key), payload)
        self.assertEqual((stat.checksum, stat.reference), (checksum, f"supabase://propensity-models/{key}"))
        self.assertNotIn(os.environ["PROPENSITY_STORAGE_TEST_SERVICE_KEY"], stat.reference)


if __name__ == "__main__": unittest.main()
