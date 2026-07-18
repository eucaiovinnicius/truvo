import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { integrations, webhookLogs, type Integration } from '@truvo/db';
import { ingestEventSchema, type IngestEvent } from '@truvo/event-schema';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  BACKOFF_MINUTES,
  TOPIC_EVENTS,
  WEBHOOKS_DB,
  type WebhookProvider,
} from './constants';
import { decryptJson } from './crypto/aes';
import { verifySignature } from './crypto/signature';
import { KafkaProducerService } from './kafka-producer.service';
import { normalize, providerEventType, type Normalized } from './normalizers';
import { RateLimiterService } from './rate-limiter.service';
import type { Database } from './webhooks.providers';

/** Entrada mínima do request que o serviço consome (agnóstico de framework). */
export interface RawWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
  rawBody?: Buffer;
}

export interface WebhookResult {
  status: 'ok' | 'ignored' | 'queued_retry';
  event_name?: string;
}

interface LogInput {
  provider: WebhookProvider;
  workspaceId: string | null;
  integrationId: string | null;
  status: 'received' | 'verified' | 'processed' | 'failed' | 'rejected' | 'retrying';
  eventType?: string;
  signatureValid?: boolean;
  httpStatus?: number;
  payloadSummary?: Record<string, unknown>;
  retryPayload?: Record<string, unknown> | null;
  error?: string;
  attempts?: number;
  nextRetryAt?: Date | null;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(WEBHOOKS_DB) private readonly db: Database,
    private readonly kafka: KafkaProducerService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Fluxo de um webhook de entrada (PRD §7 M4):
   *   1. resolve a integração (workspace) → 2. rate limit (regra 8) →
   *   3. VERIFICA HMAC-SHA256 antes de qualquer processamento (regra 6) →
   *   4. normaliza para o EventSchema → 5. publica no Kafka (async, regra 9) →
   *   6. loga tudo (webhook_logs) e agenda retry em falha (backoff 1/5/15 min).
   */
  async handleIncoming(
    provider: WebhookProvider,
    req: RawWebhookRequest,
  ): Promise<WebhookResult> {
    const headers = normalizeHeaders(req.headers);
    const query = req.query ?? {};
    const raw = extractRawBody(req);

    // 1. resolver integração (não há auth de workspace aqui — origem externa).
    const integration = await this.resolveIntegration(provider, headers, query);
    if (!integration) {
      await this.log({
        provider,
        workspaceId: null,
        integrationId: null,
        status: 'rejected',
        signatureValid: false,
        httpStatus: HttpStatus.NOT_FOUND,
        error: 'integração não encontrada para o webhook',
      });
      throw new NotFoundException('integração não encontrada para este webhook');
    }
    const workspaceId = integration.workspaceId;

    // 2. rate limit por workspace (regra 8).
    const rl = await this.rateLimiter.hit(workspaceId);
    if (!rl.allowed) {
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'rejected',
        httpStatus: HttpStatus.TOO_MANY_REQUESTS,
        error: 'rate limit excedido',
      });
      throw new HttpException('rate limit excedido', HttpStatus.TOO_MANY_REQUESTS);
    }

    // 3. verificação HMAC-SHA256 ANTES de processar (regra 6).
    const secret = this.extractSecret(integration);
    if (!secret) {
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'rejected',
        signatureValid: false,
        httpStatus: HttpStatus.UNAUTHORIZED,
        error: 'segredo de assinatura não configurado',
      });
      throw new UnauthorizedException('segredo de assinatura não configurado');
    }

    const signatureValid = verifySignature(provider, { raw, headers, query, secret });
    if (!signatureValid) {
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'rejected',
        signatureValid: false,
        httpStatus: HttpStatus.UNAUTHORIZED,
        eventType: this.safeEventType(provider, raw, headers),
        error: 'assinatura HMAC inválida',
      });
      await this.markIntegration(integration.id, workspaceId, 'error', 'assinatura inválida');
      throw new UnauthorizedException('assinatura inválida');
    }

    // 4. parse + normalização.
    const payload = parseJson(raw, req.body);
    const normalized = normalize(provider, payload, headers);
    if (!normalized) {
      // evento não mapeado → ACK 200 sem publicar (evita retries do gateway).
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'received',
        signatureValid: true,
        httpStatus: HttpStatus.OK,
        eventType: providerEventType(provider, payload, headers),
        payloadSummary: { ignored: true },
      });
      return { status: 'ignored' };
    }

    const event = this.buildEvent(workspaceId, normalized);
    const summary = summarize(normalized);

    // 5. publicar no Kafka (o M2 consome, deduplica e persiste). Regra 9.
    try {
      await this.kafka.publish(TOPIC_EVENTS, workspaceId, event);
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'processed',
        signatureValid: true,
        httpStatus: HttpStatus.OK,
        eventType: normalized.provider_event,
        payloadSummary: summary,
      });
      await this.markIntegration(integration.id, workspaceId, 'active', null);
      return { status: 'ok', event_name: normalized.event_name };
    } catch (err) {
      // falha ao publicar → agenda 1ª tentativa de retry (backoff 1/5/15 min).
      const nextRetryAt = addMinutes(BACKOFF_MINUTES[0]!);
      await this.log({
        provider,
        workspaceId,
        integrationId: integration.id,
        status: 'retrying',
        signatureValid: true,
        httpStatus: HttpStatus.ACCEPTED,
        eventType: normalized.provider_event,
        payloadSummary: summary,
        retryPayload: event as unknown as Record<string, unknown>,
        attempts: 1,
        nextRetryAt,
        error: `falha ao publicar no Kafka: ${String((err as Error)?.message ?? err)}`,
      });
      this.logger.warn(`webhook ${provider} enfileirado para retry: ${String(err)}`);
      return { status: 'queued_retry', event_name: normalized.event_name };
    }
  }

  /** Monta o EventSchema (source=webhook) e valida com ingestEventSchema. */
  private buildEvent(workspaceId: string, n: Normalized): IngestEvent {
    return ingestEventSchema.parse({
      event_id: `evt_${ulid()}`,
      event_name: n.event_name,
      source: 'webhook', // fonte mais confiável na dedup por order_id (regra 2)
      timestamp: n.timestamp,
      received_at: new Date().toISOString(),
      workspace_id: workspaceId,
      order_id: n.order_id,
      properties: n.properties ?? {},
      context: n.context ?? {},
    });
  }

  private extractSecret(integration: Integration): string | undefined {
    try {
      const creds = decryptJson<Record<string, string>>(integration.credentialsEncrypted);
      return creds.hmac_secret ?? creds.signing_secret ?? creds.secret ?? creds.hottok;
    } catch (err) {
      this.logger.error(`falha ao descriptografar credenciais: ${String(err)}`);
      throw new InternalServerErrorException('credenciais da integração inválidas');
    }
  }

  /**
   * Resolve a integração do webhook: por `integration_id` (query/header) ou por
   * identificador externo específico do provedor (ex.: domínio da loja Shopify).
   * Sempre casa também pelo `type` para evitar colisão entre provedores.
   */
  private async resolveIntegration(
    provider: WebhookProvider,
    headers: Record<string, string | undefined>,
    query: Record<string, unknown>,
  ): Promise<Integration | undefined> {
    const explicitId =
      (query['integration_id'] as string | undefined) ?? headers['x-truvo-integration-id'];
    if (explicitId) {
      const [row] = await this.db
        .select()
        .from(integrations)
        .where(and(eq(integrations.id, explicitId), eq(integrations.type, provider)))
        .limit(1);
      if (row) return row;
    }

    const externalId = this.externalId(provider, headers);
    if (externalId) {
      const [row] = await this.db
        .select()
        .from(integrations)
        .where(and(eq(integrations.type, provider), eq(integrations.externalId, externalId)))
        .limit(1);
      if (row) return row;
    }
    return undefined;
  }

  /** Identificador externo por provedor (para resolver sem integration_id). */
  private externalId(
    provider: WebhookProvider,
    headers: Record<string, string | undefined>,
  ): string | undefined {
    if (provider === 'shopify') return headers['x-shopify-shop-domain'];
    // TODO(live): Stripe (account id via Stripe-Account) / Hotmart / Kiwify —
    // preferir sempre `?integration_id=` na URL registrada no provedor.
    return undefined;
  }

  private safeEventType(
    provider: WebhookProvider,
    raw: Buffer,
    headers: Record<string, string | undefined>,
  ): string {
    try {
      return providerEventType(provider, parseJson(raw, undefined), headers);
    } catch {
      return 'unknown';
    }
  }

  private async markIntegration(
    id: string,
    workspaceId: string,
    status: 'active' | 'error',
    lastError: string | null,
  ): Promise<void> {
    try {
      await this.db
        .update(integrations)
        .set({
          status,
          lastError,
          lastEventAt: status === 'active' ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)));
    } catch (err) {
      this.logger.warn(`falha ao atualizar status da integração ${id}: ${String(err)}`);
    }
  }

  /** Persiste um registro em webhook_logs. Nunca lança (log é best-effort). */
  private async log(input: LogInput): Promise<void> {
    try {
      await this.db.insert(webhookLogs).values({
        id: `whl_${ulid()}`,
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        provider: input.provider,
        eventType: input.eventType ?? null,
        status: input.status,
        signatureValid: input.signatureValid ?? null,
        httpStatus: input.httpStatus ?? null,
        payloadSummary: input.payloadSummary ?? null,
        retryPayload: input.retryPayload ?? null,
        error: input.error ?? null,
        attempts: input.attempts ?? 0,
        nextRetryAt: input.nextRetryAt ?? null,
      });
    } catch (err) {
      this.logger.error(`falha ao gravar webhook_log: ${String(err)}`);
    }
  }
}

/* ────────────────────────── helpers de módulo ────────────────────────── */

/** Normaliza headers para `Record<string,string|undefined>` em lowercase. */
function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/**
 * Extrai o corpo CRU (bytes exatos) — indispensável para o HMAC bater (regra 6).
 *
 * Ordem de preferência:
 *   1. `req.rawBody` — disponível quando o bootstrap usa
 *      `NestFactory.create(AppModule, { rawBody: true })`.
 *   2. `req.body` quando já é Buffer/string.
 *   3. Fallback: re-serializa `req.body` (NÃO é byte-exato; o HMAC pode falhar).
 *
 * // TODO(live): habilitar `rawBody: true` no main.ts (apps/api/src/main.ts) para
 * garantir verificação HMAC byte-exata em todos os provedores.
 */
function extractRawBody(req: RawWebhookRequest): Buffer {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body ?? {}), 'utf8');
}

function parseJson(raw: Buffer, fallback: unknown): Record<string, unknown> {
  try {
    const text = raw.toString('utf8');
    if (text) return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* usa fallback */
  }
  return (fallback && typeof fallback === 'object' ? fallback : {}) as Record<string, unknown>;
}

function addMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/** Resumo sem PII crua para webhook_logs (regras 4/7). */
function summarize(n: Normalized): Record<string, unknown> {
  return {
    event_name: n.event_name,
    provider_event: n.provider_event,
    order_id: n.order_id,
    value: n.properties?.['value'],
    currency: n.properties?.['currency'],
  };
}
