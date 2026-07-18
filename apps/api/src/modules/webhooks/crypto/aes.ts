import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Criptografia AES-256-GCM das credenciais de integração (PRD §12: "credenciais
 * de integração criptografadas (AES-256)"; regra 7).
 *
 * A chave vem de `INTEGRATIONS_ENCRYPTION_KEY` (env). Qualquer string é derivada
 * para exatamente 32 bytes via SHA-256, então aceita hex/base64/passphrase.
 * Formato do blob: `v1.<iv_b64>.<authTag_b64>.<ciphertext_b64>`.
 */

const VERSION = 'v1';

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (!raw) {
    // TODO(live): definir INTEGRATIONS_ENCRYPTION_KEY (32+ bytes) no ambiente.
    throw new Error(
      'INTEGRATIONS_ENCRYPTION_KEY não configurada — necessária para cifrar credenciais (ver .env.example)',
    );
  }
  return createHash('sha256').update(raw, 'utf8').digest(); // 32 bytes
}

export function encryptJson(data: unknown): string {
  const iv = randomBytes(12); // 96-bit nonce recomendado para GCM
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptJson<T = Record<string, string>>(blob: string): T {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('formato de credencial inválido');
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
