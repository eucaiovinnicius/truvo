import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 hex — usado p/ API keys (regra 7) e, no M4, p/ email/telefone (regra 4). */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Gera uma API key nova.
 *
 * Formato em claro: `tvo_live_<32 bytes base64url>` — retornado ao cliente UMA vez.
 * Persistimos só o hash SHA-256 (regra 7) + `prefix` público p/ exibição.
 *
 * Obs.: usamos `node:crypto` (builtin) em vez de nanoid — o build do @truvo/api é
 * CommonJS e o nanoid@5 é ESM-only (não pode ser `require`d). Ver notes.
 */
export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  const secret = `tvo_live_${randomBytes(32).toString('base64url')}`;
  return { secret, hash: sha256(secret), prefix: secret.slice(0, 16) };
}
