/** Tópico Kafka compartilhado com o M2 (ingestão de eventos). */
export const TOPIC_EVENTS = 'truvo.events';

/** Token de DI para a conexão Drizzle (Postgres/Supabase) do módulo. */
export const WEBHOOKS_DB = 'WEBHOOKS_DB';

/** Provedores de webhook suportados (espelha o pgEnum integration_type). */
export const WEBHOOK_PROVIDERS = ['shopify', 'stripe', 'hotmart', 'kiwify'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/**
 * Backoff exponencial de retry em MINUTOS (PRD §7 M4: 3 tentativas — 1/5/15 min).
 * O índice é `attempts - 1` (attempts=1 → 1min, =2 → 5min, =3 → 15min).
 */
export const BACKOFF_MINUTES = [1, 5, 15] as const;
export const MAX_RETRY_ATTEMPTS = BACKOFF_MINUTES.length;

/** Rate limit padrão por workspace para webhooks (regra 8, janela de 60s). */
export const WEBHOOK_RATE_LIMIT = Number(process.env.WEBHOOK_RATE_LIMIT ?? 600);
export const WEBHOOK_RATE_WINDOW_SEC = 60;
