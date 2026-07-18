import { createDb, type Database } from '@truvo/db';
import Redis from 'ioredis';
import Stripe from 'stripe';

/**
 * Clientes de infra memoizados (singletons de processo) do M11.
 *
 * Ficam em helpers de módulo — e não só em providers com DI — de propósito: o
 * {@link FeatureGuard} é importado por OUTROS módulos e precisa funcionar sem
 * arrastar o grafo de providers do BillingModule (mesmo padrão dos guards do M2).
 *
 * Stripe é FAIL-CLOSED: sem `STRIPE_SECRET_KEY`, `getStripe()` lança — os endpoints
 * de billing então respondem 503 (ver BillingService), enquanto o resto da API
 * segue de pé (o client só é construído no primeiro uso, nunca no boot).
 */

let _db: Database | undefined;
export function getDb(): Database {
  if (!_db) _db = createDb();
  return _db;
}

let _redis: Redis | undefined;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    _redis.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[truvo/api] billing Redis error: ${err.message}`);
    });
  }
  return _redis;
}

/** Há chave secreta do Stripe configurada? (gate de fail-closed dos endpoints). */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Segredo de verificação de assinatura do webhook `stripe-billing`. */
export function stripeWebhookSecret(): string | undefined {
  const v = process.env.STRIPE_WEBHOOK_SECRET;
  return v && v.length > 0 ? v : undefined;
}

let _stripe: Stripe | undefined;
/**
 * Client Stripe memoizado. Lança se `STRIPE_SECRET_KEY` estiver ausente — chame
 * atrás de {@link isStripeConfigured} para traduzir em 503 (fail-closed).
 *
 * `apiVersion` é OMITIDO de propósito (usa o default fixado na conta Stripe),
 * evitando acoplar o código a um literal de versão do SDK. Pode ser sobrescrito
 * via `STRIPE_API_VERSION`.
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      // TODO(live): configurar STRIPE_SECRET_KEY (test mode) — ver .env.example.
      throw new Error('STRIPE_SECRET_KEY não configurado — billing indisponível');
    }
    const config: Stripe.StripeConfig = { typescript: true };
    const apiVersion = process.env.STRIPE_API_VERSION;
    if (apiVersion) {
      config.apiVersion = apiVersion as Stripe.StripeConfig['apiVersion'];
    }
    _stripe = new Stripe(key, config);
  }
  return _stripe;
}
