import { Inject, Injectable } from '@nestjs/common';
// NOTA DE INTEGRAÇÃO: `integrationOutConfigs`/`integrationOutLogs` são definidos em
// packages/db/src/schema/integrations-out.ts e precisam ser re-exportados pelo barrel
// packages/db/src/schema/index.ts (não editado por este módulo). Ver openTODOs.
import {
  integrationOutConfigs,
  type IntegrationOutConfig,
  type IntegrationOutConfigJson,
  type IntegrationOutPlatform,
} from '@truvo/db';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { INTEGRATIONS_OUT_DB } from './integrations-out.constants';
import { decryptJson, encryptJson } from './crypto';
import type { Database } from './integrations-out.providers';
import type { DecryptedCredentials } from './clients/types';
import type { UpsertConfigDto } from './dto/integrations-out.dto';

/** Config sem o blob de credenciais — segura para a API (regra 7). */
export type IntegrationOutConfigPublic = Omit<IntegrationOutConfig, 'credentialsEncrypted'> & {
  hasCredentials: boolean;
};

/**
 * M9 — CRUD da configuração de saída por workspace/plataforma + descriptografia das
 * credenciais para uso interno (nunca expostas na API). Toda query é escopada por
 * workspace (regra 1).
 */
@Injectable()
export class IntegrationOutConfigService {
  constructor(@Inject(INTEGRATIONS_OUT_DB) private readonly db: Database) {}

  private sanitize(row: IntegrationOutConfig): IntegrationOutConfigPublic {
    const { credentialsEncrypted, ...rest } = row;
    return { ...rest, hasCredentials: Boolean(credentialsEncrypted) };
  }

  /** Todas as configs do workspace (público, sem segredos). */
  async list(workspaceId: string): Promise<IntegrationOutConfigPublic[]> {
    const rows = await this.db
      .select()
      .from(integrationOutConfigs)
      .where(eq(integrationOutConfigs.workspaceId, workspaceId));
    return rows.map((r) => this.sanitize(r));
  }

  /** Config de uma plataforma (row bruto, com blob cifrado). null se não existe. */
  async findRaw(
    workspaceId: string,
    platform: IntegrationOutPlatform,
  ): Promise<IntegrationOutConfig | null> {
    const [row] = await this.db
      .select()
      .from(integrationOutConfigs)
      .where(
        and(
          eq(integrationOutConfigs.workspaceId, workspaceId),
          eq(integrationOutConfigs.platform, platform),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getPublic(
    workspaceId: string,
    platform: IntegrationOutPlatform,
  ): Promise<IntegrationOutConfigPublic | null> {
    const row = await this.findRaw(workspaceId, platform);
    return row ? this.sanitize(row) : null;
  }

  /** Todas as configs HABILITADAS do workspace (para o forwarder). */
  async listEnabled(workspaceId: string): Promise<IntegrationOutConfig[]> {
    const rows = await this.db
      .select()
      .from(integrationOutConfigs)
      .where(
        and(
          eq(integrationOutConfigs.workspaceId, workspaceId),
          eq(integrationOutConfigs.enabled, true),
        ),
      );
    return rows;
  }

  /** Descriptografa as credenciais de uma config (uso interno). */
  decryptCredentials(row: IntegrationOutConfig): DecryptedCredentials {
    if (!row.credentialsEncrypted) return {};
    return decryptJson<DecryptedCredentials>(row.credentialsEncrypted);
  }

  /** Upsert idempotente por (workspace, platform). */
  async upsert(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    dto: UpsertConfigDto,
  ): Promise<IntegrationOutConfigPublic> {
    const existing = await this.findRaw(workspaceId, platform);

    if (!existing) {
      const row = {
        id: `iout_${ulid()}`,
        workspaceId,
        platform,
        enabled: dto.enabled ?? false,
        credentialsEncrypted: dto.credentials ? encryptJson(dto.credentials) : '',
        config: (dto.config ?? {}) as IntegrationOutConfigJson,
        status: dto.status ?? 'pending',
      };
      const [created] = await this.db.insert(integrationOutConfigs).values(row).returning();
      return this.sanitize(created!);
    }

    const patch: Partial<typeof integrationOutConfigs.$inferInsert> = { updatedAt: new Date() };
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.credentials !== undefined) patch.credentialsEncrypted = encryptJson(dto.credentials);
    if (dto.config !== undefined) {
      // merge raso: preserva chaves não enviadas.
      patch.config = { ...existing.config, ...(dto.config as IntegrationOutConfigJson) };
    }

    const [updated] = await this.db
      .update(integrationOutConfigs)
      .set(patch)
      .where(
        and(
          eq(integrationOutConfigs.workspaceId, workspaceId),
          eq(integrationOutConfigs.platform, platform),
        ),
      )
      .returning();
    return this.sanitize(updated!);
  }

  async remove(workspaceId: string, platform: IntegrationOutPlatform): Promise<void> {
    await this.db
      .delete(integrationOutConfigs)
      .where(
        and(
          eq(integrationOutConfigs.workspaceId, workspaceId),
          eq(integrationOutConfigs.platform, platform),
        ),
      );
  }

  /** Marca o resultado do último envio/teste (status + erro + timestamp). */
  async markResult(
    workspaceId: string,
    platform: IntegrationOutPlatform,
    ok: boolean,
    error?: string,
  ): Promise<void> {
    await this.db
      .update(integrationOutConfigs)
      .set({
        status: ok ? 'active' : 'error',
        lastError: ok ? null : (error ?? 'erro desconhecido'),
        lastForwardAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationOutConfigs.workspaceId, workspaceId),
          eq(integrationOutConfigs.platform, platform),
        ),
      );
  }
}
