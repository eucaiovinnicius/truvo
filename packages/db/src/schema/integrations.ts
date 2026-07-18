import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * M4 — WEBHOOK RECEIVERS (PRD §7 Módulo 4 e §8).
 *
 * Tabelas Postgres do módulo de webhooks/integrações:
 *   - integrations  → configuração de cada integração de entrada por workspace
 *                     (Shopify/Stripe/Hotmart/Kiwify). Credenciais SEMPRE
 *                     criptografadas em repouso (AES-256-GCM, regra 12/§12).
 *   - webhook_logs  → auditoria de cada webhook recebido: timestamp, tipo,
 *                     status, payload resumido (sem PII), erro e controle de retry.
 *
 * Regras de negócio respeitadas:
 *   1  — toda query filtra por workspace_id (índices abaixo);
 *   6  — a verificação HMAC-SHA256 acontece na camada de serviço antes de processar;
 *   4/7 — nenhum e-mail/telefone/segredo em texto puro (credenciais cifradas;
 *         payload_summary guarda apenas agregados e email_hash quando houver).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (barrel) na onda de integração para que
 * `@truvo/db` exponha `integrations`, `webhookLogs` e os enums. O barrel não é
 * editado por este módulo (contrato de arquivos).
 */

/** Provedores de webhook suportados no MVP (PRD §7 M4). */
export const integrationTypeEnum = pgEnum('integration_type', [
  'shopify',
  'stripe',
  'hotmart',
  'kiwify',
]);

/** Ciclo de vida de uma integração. */
export const integrationStatusEnum = pgEnum('integration_status', [
  'pending', // criada, ainda sem webhook recebido/validado
  'active', // recebendo e validando webhooks
  'inactive', // desativada manualmente
  'error', // última tentativa falhou (ver last_error)
]);

/** Status de cada webhook logado. */
export const webhookLogStatusEnum = pgEnum('webhook_log_status', [
  'received', // recebido, evento não mapeado / ignorado
  'verified', // assinatura HMAC verificada
  'processed', // normalizado e publicado no Kafka com sucesso
  'failed', // erro definitivo após retries
  'rejected', // assinatura inválida / integração desconhecida / rate limit
  'retrying', // aguardando retry (backoff 1/5/15 min)
]);

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(), // gerado no serviço: int_<ulid>
    workspaceId: text('workspace_id').notNull(),
    type: integrationTypeEnum('type').notNull(),
    name: text('name').notNull(),
    /**
     * Identificador externo usado para casar o webhook com a integração quando
     * não há `integration_id` na URL. Ex.: domínio da loja Shopify
     * (`X-Shopify-Shop-Domain`), account id do Stripe, etc.
     */
    externalId: text('external_id'),
    /**
     * Credenciais cifradas (AES-256-GCM). Blob no formato
     * `v1.<iv>.<tag>.<ciphertext>` (base64) de um JSON com os segredos do
     * provedor (hmac_secret / signing_secret / api_key / hottok...).
     * NUNCA guardar segredo em texto puro (regra 7 / §12).
     */
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    /** Config não-secreta (shop domain, flags, mapeamentos custom). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: integrationStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // regra 1: acesso sempre escopado por workspace.
    workspaceIdx: index('integrations_workspace_idx').on(t.workspaceId),
    // resolução de webhook por provedor + identificador externo.
    typeExternalIdx: index('integrations_type_external_idx').on(t.type, t.externalId),
  }),
);

export const webhookLogs = pgTable(
  'webhook_logs',
  {
    id: text('id').primaryKey(), // whl_<ulid>
    workspaceId: text('workspace_id'), // nulo quando a integração não foi resolvida
    integrationId: text('integration_id'),
    provider: integrationTypeEnum('provider').notNull(),
    /** Evento do provedor (ex.: `orders/paid`, `payment_intent.succeeded`). */
    eventType: text('event_type'),
    status: webhookLogStatusEnum('status').notNull(),
    signatureValid: boolean('signature_valid'),
    httpStatus: integer('http_status'),
    /** Resumo sem PII crua (event_name, order_id, value, currency, email_hash). */
    payloadSummary: jsonb('payload_summary').$type<Record<string, unknown>>(),
    /**
     * Evento já normalizado (EventSchema) guardado apenas para permitir o retry
     * de publicação no Kafka. Contém somente dados hasheados/agregados.
     */
    retryPayload: jsonb('retry_payload').$type<Record<string, unknown>>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('webhook_logs_workspace_idx').on(t.workspaceId),
    integrationIdx: index('webhook_logs_integration_idx').on(t.integrationId),
    // varredura do worker de retry: status + próxima tentativa.
    retryIdx: index('webhook_logs_retry_idx').on(t.status, t.nextRetryAt),
  }),
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type WebhookLog = typeof webhookLogs.$inferSelect;
export type NewWebhookLog = typeof webhookLogs.$inferInsert;
