import { Inject, Injectable, NotFoundException } from '@nestjs/common';
// NOTA DE INTEGRAÇÃO: `integrations` e `webhookLogs` são definidos em
// packages/db/src/schema/integrations.ts. Precisam ser re-exportados pelo barrel
// packages/db/src/schema/index.ts (não editado por este módulo) para que
// @truvo/db os exponha. Ver openTODOs.
import { integrations, webhookLogs, type Integration } from '@truvo/db';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { WEBHOOKS_DB } from './constants';
import { decryptJson, encryptJson } from './crypto/aes';
import type {
  CreateIntegrationDto,
  ListIntegrationsQuery,
  LogsQuery,
  UpdateIntegrationDto,
} from './dto/integration.dto';
import type { Database } from './webhooks.providers';
import { AuditService } from '../audit/audit.service';

/** Integração sem os campos sensíveis, segura para retornar na API. */
export type IntegrationPublic = Omit<Integration, 'credentialsEncrypted'> & {
  hasCredentials: boolean;
};

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(WEBHOOKS_DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Nunca vaza `credentialsEncrypted` para fora do serviço (regra 7). */
  private sanitize(row: Integration): IntegrationPublic {
    const { credentialsEncrypted, ...rest } = row;
    return { ...rest, hasCredentials: Boolean(credentialsEncrypted) };
  }

  async create(workspaceId: string, dto: CreateIntegrationDto, actorUserId?: string): Promise<IntegrationPublic> {
    const id = `int_${ulid()}`;
    const [row] = await this.db
      .insert(integrations)
      .values({
        id,
        workspaceId, // regra 1: sempre escopado
        type: dto.type,
        name: dto.name,
        externalId: dto.external_id ?? null,
        credentialsEncrypted: encryptJson(dto.credentials), // AES-256-GCM
        config: (dto.config ?? {}) as Record<string, unknown>,
        status: dto.status ?? 'pending',
      })
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.created',
      resourceType: 'integration',
      resourceId: id,
      actorUserId,
      metadata: { type: dto.type, name: dto.name },
    });

    return this.sanitize(row!);
  }

  async list(workspaceId: string, query: ListIntegrationsQuery): Promise<IntegrationPublic[]> {
    const filters: SQL[] = [eq(integrations.workspaceId, workspaceId)];
    if (query.type) filters.push(eq(integrations.type, query.type));
    if (query.status) filters.push(eq(integrations.status, query.status));

    const rows = await this.db
      .select()
      .from(integrations)
      .where(and(...filters))
      .orderBy(desc(integrations.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return rows.map((r) => this.sanitize(r));
  }

  /** Carrega uma integração garantindo o escopo do workspace (regra 1). */
  private async findOwned(workspaceId: string, id: string): Promise<Integration> {
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new NotFoundException('integração não encontrada');
    return row;
  }

  async get(workspaceId: string, id: string): Promise<IntegrationPublic> {
    return this.sanitize(await this.findOwned(workspaceId, id));
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateIntegrationDto,
    actorUserId?: string,
  ): Promise<IntegrationPublic> {
    await this.findOwned(workspaceId, id); // garante propriedade

    const patch: Partial<typeof integrations.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.external_id !== undefined) patch.externalId = dto.external_id;
    if (dto.config !== undefined) patch.config = dto.config as Record<string, unknown>;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.credentials !== undefined) patch.credentialsEncrypted = encryptJson(dto.credentials);

    const [row] = await this.db
      .update(integrations)
      .set(patch)
      .where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.updated',
      resourceType: 'integration',
      resourceId: id,
      actorUserId,
      metadata: { fields_changed: Object.keys(dto) },
    });

    return this.sanitize(row!);
  }

  async remove(workspaceId: string, id: string, actorUserId?: string): Promise<void> {
    await this.findOwned(workspaceId, id);
    await this.db
      .delete(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)));

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.deleted',
      resourceType: 'integration',
      resourceId: id,
      actorUserId,
    });
  }

  /**
   * Testa uma integração: descriptografa as credenciais e confere que o segredo
   * de assinatura está presente e íntegro. Estrutura pronta para um ping real
   * na API do provedor.
   * // TODO(live): chamada real ao provedor (ex.: GET shop.json na Shopify,
   * account retrieve na Stripe) para validar as credenciais de ponta a ponta.
   */
  async test(
    workspaceId: string,
    id: string,
  ): Promise<{ ok: boolean; checks: Record<string, boolean>; message: string }> {
    const row = await this.findOwned(workspaceId, id);
    const checks: Record<string, boolean> = { credentials_decrypt: false, signing_secret: false };
    try {
      const creds = decryptJson<Record<string, string>>(row.credentialsEncrypted);
      checks.credentials_decrypt = true;
      checks.signing_secret = Boolean(
        creds.hmac_secret ?? creds.signing_secret ?? creds.secret ?? creds.hottok,
      );
    } catch {
      checks.credentials_decrypt = false;
    }
    const ok = Object.values(checks).every(Boolean);
    return {
      ok,
      checks,
      message: ok
        ? 'credenciais válidas (verificação estrutural)'
        : 'credenciais inválidas ou segredo de assinatura ausente',
    };
  }

  /** Logs de webhook da integração, sempre escopados por workspace (regra 1). */
  async logs(workspaceId: string, id: string, query: LogsQuery) {
    await this.findOwned(workspaceId, id);
    const filters: SQL[] = [
      eq(webhookLogs.workspaceId, workspaceId),
      eq(webhookLogs.integrationId, id),
    ];
    if (query.status) filters.push(eq(webhookLogs.status, query.status));

    return this.db
      .select({
        id: webhookLogs.id,
        provider: webhookLogs.provider,
        eventType: webhookLogs.eventType,
        status: webhookLogs.status,
        signatureValid: webhookLogs.signatureValid,
        httpStatus: webhookLogs.httpStatus,
        payloadSummary: webhookLogs.payloadSummary,
        error: webhookLogs.error,
        attempts: webhookLogs.attempts,
        nextRetryAt: webhookLogs.nextRetryAt,
        receivedAt: webhookLogs.receivedAt,
      })
      .from(webhookLogs)
      .where(and(...filters))
      .orderBy(desc(webhookLogs.receivedAt))
      .limit(query.limit)
      .offset(query.offset);
  }
}
