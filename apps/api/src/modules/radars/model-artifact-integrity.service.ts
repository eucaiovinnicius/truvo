import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface StoredModelArtifact {
  artifactProvider: string; artifactBucket: string; artifactObjectKey: string; artifactChecksum: string;
}

export interface ArtifactIntegrityVerifier { verify(model: StoredModelArtifact): Promise<{ ok: boolean; reason?: string }>; }

/** Server-side counterpart to the worker ArtifactStore. It only reads a private
 * object through Supabase Storage and compares the immutable SHA-256 recorded by
 * the worker; neither URLs nor credentials enter registry responses or the DB. */
@Injectable()
export class ModelArtifactIntegrityService implements ArtifactIntegrityVerifier {
  async verify(model: StoredModelArtifact): Promise<{ ok: boolean; reason?: string }> {
    if (model.artifactProvider !== 'supabase_storage') return { ok: false, reason: 'unsupported_artifact_provider' };
    const base = process.env.SUPABASE_URL?.replace(/\/$/, ''); const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return { ok: false, reason: 'artifact_verifier_unconfigured' };
    try {
      const response = await fetch(`${base}/storage/v1/object/${encodeURIComponent(model.artifactBucket)}/${model.artifactObjectKey.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${key}`, apikey: key } });
      if (!response.ok) return { ok: false, reason: response.status === 404 ? 'artifact_not_found' : 'artifact_read_failed' };
      const checksum = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      return checksum === model.artifactChecksum ? { ok: true } : { ok: false, reason: 'artifact_checksum_mismatch' };
    } catch { return { ok: false, reason: 'artifact_read_failed' }; }
  }
}
