import { createHash } from 'node:crypto';

/**
 * Classificação e handling reutilizável de PII/secrets/credenciais (Order 035 §2).
 * Fonte única de verdade para hashing de email/telefone — `integrations-out/match-keys.ts`
 * reexporta estas funções em vez de duplicar a implementação (regra 4/7).
 */

const HEX_64 = /^[a-f0-9]{64}$/;

export type PiiCategory = 'email' | 'phone' | 'external_id' | 'hash' | 'credential' | 'unclassified';

/** Nomes de campo (case-insensitive) reconhecidos por categoria. Mantido em sincronia
 * com a regex de `redact()` de `@truvo/observability` — aqui classificamos por
 * INTENÇÃO de handling; lá redigimos por padrão de nome como rede de segurança. */
const CATEGORY_PATTERNS: Array<{ category: PiiCategory; pattern: RegExp }> = [
  { category: 'credential', pattern: /token|secret|password|api[-_]?key|credential|cookie|authorization/i },
  { category: 'email', pattern: /email/i },
  { category: 'phone', pattern: /phone|telefone|mobile|celular/i },
  { category: 'hash', pattern: /_hash$|^hash$/i },
  { category: 'external_id', pattern: /external[-_]?id|user[-_]?id|customer[-_]?id|anonymous[-_]?id|click[-_]?id/i },
];

/** Classifica um nome de campo por convenção de nomenclatura. Usado para decidir
 * handling (hashear, nunca persistir em analytics, nunca logar em claro). */
export function classifyField(key: string): PiiCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(key)) return category;
  }
  return 'unclassified';
}

/** SHA-256 hex de uma string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Aceita e-mail em claro OU já hasheado. Normaliza (trim+lowercase) e hasheia se
 * ainda não for um SHA-256 hex. `undefined` quando vazio.
 */
export function normalizeEmailHash(input?: string | null): string | undefined {
  if (!input) return undefined;
  const v = input.trim().toLowerCase();
  if (!v) return undefined;
  if (HEX_64.test(v)) return v; // já é hash
  return sha256Hex(v);
}

/**
 * Telefone: aceita claro ou hash. Normaliza para dígitos (E.164 sem '+') e hasheia.
 * `undefined` quando vazio.
 */
export function normalizePhoneHash(input?: string | null): string | undefined {
  if (!input) return undefined;
  const raw = input.trim().toLowerCase();
  if (HEX_64.test(raw)) return raw; // já é hash
  const digits = input.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return sha256Hex(digits);
}

/** `value` já é um SHA-256 hex (64 chars)? Útil para validar que um campo marcado
 * como PII crua não está prestes a ser persistido sem hashing. */
export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value.trim().toLowerCase());
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_LIKE = /^\+?[\d\s().-]{8,}$/;

/**
 * Heurística defensiva: `value` PARECE email/telefone em claro? Usado antes de
 * gravar em stores analíticos (ClickHouse/logs) para evitar duplicar PII crua sem
 * necessidade explícita (Order 035 §2 — "do not duplicate raw PII into analytics
 * stores without an explicit need"). Não é uma garantia — é um alarme barato.
 */
export function isLikelyRawPii(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || isSha256Hex(v)) return false;
  return EMAIL_LIKE.test(v) || (PHONE_LIKE.test(v) && /\d{8,}/.test(v.replace(/\D/g, '')));
}
