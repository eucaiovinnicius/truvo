import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifiedSupabaseClaims {
  sub: string;
  email?: string;
  aud: string | string[];
  exp: number;
  iss?: string;
  role?: string;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Verifies the legacy HS256 JWT contract emitted by Supabase Auth. This is the
 * production verifier path when SUPABASE_JWT_SECRET is configured; it is kept
 * side-effect free so the exact middleware behavior can be exercised locally. */
export function verifySupabaseJwt(
  token: string,
  secret: string,
  options: { nowSeconds?: number; issuer?: string } = {},
): VerifiedSupabaseClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error('malformed_token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeSegment(encodedHeader);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('unsupported_token_algorithm');

  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_signature');

  const claims = decodeSegment(encodedPayload);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new Error('missing_subject');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('expired_token');
  if (typeof claims.nbf === 'number' && claims.nbf > now) throw new Error('token_not_active');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes('authenticated')) throw new Error('invalid_audience');
  if (options.issuer && claims.iss !== options.issuer) throw new Error('invalid_issuer');

  return claims as unknown as VerifiedSupabaseClaims;
}
