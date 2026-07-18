import { createHash } from 'node:crypto';

/** SHA-256 hex de uma string (regras 4/7). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** E-mail normalizado (trim + lowercase) → SHA-256. Nunca persistir plain text (regra 4). */
export function hashEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  return sha256Hex(normalized);
}

/** Telefone normalizado (apenas dígitos e '+') → SHA-256. */
export function hashPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  const normalized = phone.replace(/[^\d+]/g, '');
  if (!normalized) return undefined;
  return sha256Hex(normalized);
}
