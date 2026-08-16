import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { apiKeys } from '@truvo/db';
import { getDb } from './infra';
import { generateApiKey } from './crypto.util';
import { AuditService } from '../audit/audit.service';

/**
 * CRUD de API keys. Toda operação filtra por `workspace_id` (regra 1) e nunca
 * expõe o hash. O segredo em claro só é retornado UMA vez, na criação (regra 7).
 * Ciclo de vida da key (criação/revogação) é auditado (Order 035 §4).
 */
@Injectable()
export class ApiKeysService {
  private readonly db = getDb();

  constructor(private readonly audit: AuditService) {}

  /** GET /v1/api-keys — lista chaves do workspace (sem hash/segredo). */
  async list(workspaceId: string) {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        status: apiKeys.status,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, workspaceId))
      .orderBy(desc(apiKeys.createdAt));
    return { apiKeys: rows };
  }

  /**
   * POST /v1/api-keys — cria uma chave. Retorna o segredo em claro (`key`) UMA
   * vez; depois só o `prefix` fica visível.
   */
  async create(workspaceId: string, name: string, createdBy?: string, createdByEmail?: string) {
    const { secret, hash, prefix } = generateApiKey();
    const rows = await this.db
      .insert(apiKeys)
      .values({ workspaceId, name, keyHash: hash, prefix, createdBy })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        status: apiKeys.status,
        createdAt: apiKeys.createdAt,
      });

    await this.audit.record({
      workspaceId,
      category: 'api_key',
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: rows[0]?.id ?? '',
      actorUserId: createdBy,
      actorEmail: createdByEmail,
      metadata: { name, prefix },
    });

    return {
      ...rows[0],
      // ⚠️ mostrado só agora — não é recuperável depois (guardamos só o hash).
      key: secret,
    };
  }

  /** DELETE /v1/api-keys/:id — revoga (soft) a chave do workspace. */
  async revoke(workspaceId: string, id: string, actor?: { id: string; email?: string }) {
    const rows = await this.db
      .update(apiKeys)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId)))
      .returning({ id: apiKeys.id });

    if (rows.length === 0) {
      throw new NotFoundException('API key não encontrada neste workspace');
    }

    await this.audit.record({
      workspaceId,
      category: 'api_key',
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: id,
      actorUserId: actor?.id,
      actorEmail: actor?.email,
    });

    return { id: rows[0].id, status: 'revoked' as const };
  }
}
