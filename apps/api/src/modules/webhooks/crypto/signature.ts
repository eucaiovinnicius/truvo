import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookProvider } from '../constants';
import { metrics, structuredLog } from '@truvo/observability';

/**
 * Verificação de assinatura HMAC-SHA256 dos webhooks (regra 6 / PRD §7 M4 e §12:
 * "webhook signature verification obrigatória"). SEMPRE roda ANTES de qualquer
 * processamento, sobre o corpo cru (bytes exatos) da requisição.
 */

export interface VerifyInput {
  /** Corpo cru da requisição (bytes exatos — essencial para o HMAC bater). */
  raw: Buffer;
  headers: Record<string, string | undefined>;
  query: Record<string, unknown>;
  /** Segredo do provedor (descriptografado das credenciais da integração). */
  secret: string;
  /** URL completa da requisição — necessária para o esquema v3 do HubSpot. */
  url?: string;
  /** Método HTTP — necessário para o esquema v3 do HubSpot. */
  method?: string;
}

export function hmac(
  data: Buffer | string,
  secret: string,
  encoding: 'base64' | 'hex' = 'base64',
): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

/** Comparação em tempo constante, resistente a diferença de tamanho. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Shopify: `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(rawBody, secret)). */
export function verifyShopify({ raw, headers, secret }: VerifyInput): boolean {
  const provided = headers['x-shopify-hmac-sha256'];
  if (!provided) return false;
  return safeEqual(hmac(raw, secret, 'base64'), provided);
}

/**
 * Stripe: header `Stripe-Signature: t=<ts>,v1=<sig>` onde
 * sig = hex(HMAC-SHA256(`${t}.${rawBody}`, signing_secret)). Esquema oficial.
 */
export function verifyStripe({ raw, headers, secret }: VerifyInput): boolean {
  const header = headers['stripe-signature'];
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const signedPayload = `${t}.${raw.toString('utf8')}`;
  return safeEqual(hmac(signedPayload, secret, 'hex'), v1);
}

/**
 * Hotmart: verifica HMAC-SHA256 do corpo cru quando há header de assinatura;
 * caso o provedor use apenas o token `hottok`, compara em tempo constante.
 * // TODO(live): confirmar o header/mecanismo exato da versão do webhook Hotmart.
 */
export function verifyHotmart({ raw, headers, query, secret }: VerifyInput): boolean {
  const provided = headers['x-hotmart-hmac-sha256'] ?? headers['x-hotmart-signature'];
  if (provided) {
    return (
      safeEqual(hmac(raw, secret, 'base64'), provided) ||
      safeEqual(hmac(raw, secret, 'hex'), provided)
    );
  }
  const hottok = headers['x-hotmart-hottok'] ?? (query['hottok'] as string | undefined);
  if (hottok) return safeEqual(hottok, secret);
  return false;
}

/**
 * Kiwify: assinatura em `X-Kiwify-Signature` ou query `?signature=`.
 * // TODO(live): confirmar hex vs base64 na doc atual da Kiwify.
 */
export function verifyKiwify({ raw, headers, query, secret }: VerifyInput): boolean {
  const provided =
    headers['x-kiwify-signature'] ?? (query['signature'] as string | undefined);
  if (!provided) return false;
  return (
    safeEqual(hmac(raw, secret, 'hex'), provided) ||
    safeEqual(hmac(raw, secret, 'base64'), provided)
  );
}

/**
 * HubSpot:
 *   · v3 (recomendado): `X-HubSpot-Signature-V3` =
 *       base64(HMAC-SHA256(clientSecret, `${METHOD}${URL}${rawBody}${timestamp}`)),
 *       com `X-HubSpot-Request-Timestamp`. Rejeita timestamps > 5 min (anti-replay).
 *   · v1 (fallback): `X-HubSpot-Signature` = hex(SHA256(clientSecret + rawBody)).
 * O segredo é o Client Secret do app HubSpot (guardado em `client_secret`).
 * // TODO(live): a URL v3 deve ser EXATAMENTE a registrada no app (cuidado com
 * // proxy/porta); em produção reconstruir a partir de X-Forwarded-* corretos.
 */
export function verifyHubspot({ raw, headers, secret, url, method }: VerifyInput): boolean {
  const v3 = headers['x-hubspot-signature-v3'];
  const timestamp = headers['x-hubspot-request-timestamp'];
  if (v3 && timestamp && url) {
    const ts = Number(timestamp);
    const fresh = Number.isFinite(ts) && Math.abs(Date.now() - ts) <= 5 * 60_000;
    if (fresh) {
      const base = `${(method ?? 'POST').toUpperCase()}${url}${raw.toString('utf8')}${timestamp}`;
      if (safeEqual(hmac(base, secret, 'base64'), v3)) return true;
    }
  }
  const v1 = headers['x-hubspot-signature'];
  if (v1) {
    const digest = createHash('sha256')
      .update(secret + raw.toString('utf8'), 'utf8')
      .digest('hex');
    if (safeEqual(digest, v1)) return true;
  }
  return false;
}

const VERIFIERS: Record<WebhookProvider, (input: VerifyInput) => boolean> = {
  shopify: verifyShopify,
  stripe: verifyStripe,
  hotmart: verifyHotmart,
  kiwify: verifyKiwify,
  hubspot: verifyHubspot,
};

export type WebhookVerificationReason = 'valid' | 'invalid_signature' | 'timestamp' | 'replay';

export function recordWebhookVerificationFailure(provider: WebhookProvider, reason: Exclude<WebhookVerificationReason, 'valid'>): void {
  metrics.increment('webhook_verification_failures_total', { provider, reason });
  structuredLog('warn', 'webhook_verification_failed', { provider, reason });
}

export function verifySignatureResult(
  provider: WebhookProvider,
  input: VerifyInput,
): { valid: boolean; reason: WebhookVerificationReason } {
  if (provider === 'hubspot' && input.headers['x-hubspot-signature-v3']) {
    const timestamp = Number(input.headers['x-hubspot-request-timestamp']);
    if (!Number.isFinite(timestamp)) return { valid: false, reason: 'timestamp' };
    if (Math.abs(Date.now() - timestamp) > 5 * 60_000) return { valid: false, reason: 'replay' };
  }
  const valid = VERIFIERS[provider](input);
  return { valid, reason: valid ? 'valid' : 'invalid_signature' };
}

/** Dispatcher: verifica a assinatura conforme o provedor. */
export function verifySignature(provider: WebhookProvider, input: VerifyInput): boolean {
  return verifySignatureResult(provider, input).valid;
}
