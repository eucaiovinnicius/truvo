import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Order 050 — AES-256-GCM for connector credentials. SAME format/key as M4
 * (`webhooks/crypto/aes.ts`) and M9 (`integrations-out/crypto.ts`) — interoperable
 * blobs (`v1.<iv_b64>.<authTag_b64>.<ciphertext_b64>`), same `INTEGRATIONS_ENCRYPTION_KEY`
 * env var. Kept as its own module-local copy, matching the established convention
 * (M9 already duplicates M4's copy rather than importing it) — "use existing secure
 * secret/encryption abstractions, do not add a new secret vendor" means the SAME
 * algorithm/format/key, not literally the same source file.
 */
const VERSION = 'v1';

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('INTEGRATIONS_ENCRYPTION_KEY não configurada — necessária para cifrar credenciais de conector (ver .env.example)');
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptJson(data: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptJson<T = Record<string, unknown>>(blob: string): T {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('formato de credencial de conector inválido');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const ciphertext = Buffer.from(ctB64!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
