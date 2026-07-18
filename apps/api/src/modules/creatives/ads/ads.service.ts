import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  creativeAdAccounts,
  creatives,
  type CreativeAdAccount,
  type CreativePlatform,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { insertCreativeDaily } from '../creatives-ch';
import { resolveDayRange } from '../creatives.constants';
import { MetaAdsClient } from './meta-ads.client';
import { GoogleAdsClient } from './google-ads.client';
import { TikTokAdsClient } from './tiktok-ads.client';
import type { AdsPlatformClient, CreativeMeta } from './types';

export interface SyncResult {
  workspace_id: string;
  range: { start: string; end: string };
  accounts: Array<{
    account_id: string;
    platform: CreativePlatform;
    external_account_id: string;
    configured: boolean;
    daily_rows: number;
    creatives: number;
    error?: string;
  }>;
  total_daily_rows: number;
}

/**
 * M10 — orquestra o SYNC das Ads APIs para o storage do Truvo.
 *
 * Para cada `creative_ad_accounts` ativo do workspace: busca insights diários
 * (→ ClickHouse `creative_daily`) e metadados (→ Postgres cache `creatives`).
 * Fail-closed: cliente sem token no ENV é `configured=false` e não escreve nada —
 * nunca inventamos spend/criativo (regra 12). O cursor de sync é avançado por conta.
 *
 * A ENTREGA é acionável por endpoint (POST /v1/creatives/sync) e por um worker
 * agendado (// TODO(live): cron diário — reusar o padrão de worker do consumer).
 */
@Injectable()
export class AdsService {
  private readonly logger = new Logger(AdsService.name);
  private readonly clients: Record<CreativePlatform, AdsPlatformClient>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly meta: MetaAdsClient,
    private readonly google: GoogleAdsClient,
    private readonly tiktok: TikTokAdsClient,
  ) {
    this.clients = { meta, google, tiktok };
  }

  /** Alguma plataforma tem credencial no ENV? (sinal de "fonte M10 ligada".) */
  anyConfigured(): boolean {
    return (
      this.meta.isConfigured() || this.google.isConfigured() || this.tiktok.isConfigured()
    );
  }

  // ─────────────────────────── contas de anúncio ───────────────────────────

  async listAccounts(workspaceId: string): Promise<CreativeAdAccount[]> {
    return this.db
      .select()
      .from(creativeAdAccounts)
      .where(eq(creativeAdAccounts.workspaceId, workspaceId));
  }

  /** Conecta (ou re-ativa) uma conta de anúncio ao workspace. Idempotente. */
  async upsertAccount(
    workspaceId: string,
    input: { platform: CreativePlatform; externalAccountId: string; name?: string; config?: Record<string, unknown> },
  ): Promise<CreativeAdAccount> {
    const existing = await this.db
      .select()
      .from(creativeAdAccounts)
      .where(
        and(
          eq(creativeAdAccounts.workspaceId, workspaceId),
          eq(creativeAdAccounts.platform, input.platform),
          eq(creativeAdAccounts.externalAccountId, input.externalAccountId),
        ),
      )
      .limit(1);

    const now = new Date();
    const prev = existing[0];
    if (prev) {
      const updated = {
        name: input.name ?? prev.name,
        config: input.config ?? prev.config,
        status: 'active' as const,
        updatedAt: now,
      };
      await this.db
        .update(creativeAdAccounts)
        .set(updated)
        .where(eq(creativeAdAccounts.id, prev.id));
      return { ...prev, ...updated };
    }

    const row = {
      id: `cra_${ulid()}`,
      workspaceId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      name: input.name ?? '',
      config: input.config ?? {},
      status: 'active' as const,
      syncCursor: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(creativeAdAccounts).values(row);
    return row;
  }

  // ─────────────────────────────── sync ───────────────────────────────

  /**
   * Sincroniza as contas do workspace no intervalo dado (default: últimos 30d).
   * `platform` opcional restringe a uma plataforma.
   */
  async syncWorkspace(
    workspaceId: string,
    opts: { start?: string; end?: string; platform?: CreativePlatform } = {},
  ): Promise<SyncResult> {
    const range = resolveDayRange(opts.start, opts.end);
    const accounts = (await this.listAccounts(workspaceId)).filter(
      (a) => a.status !== 'inactive' && (!opts.platform || a.platform === opts.platform),
    );

    const result: SyncResult = {
      workspace_id: workspaceId,
      range: { start: range.startDay, end: range.endDay },
      accounts: [],
      total_daily_rows: 0,
    };

    for (const account of accounts) {
      const client = this.clients[account.platform];
      const configured = client.isConfigured();
      const entry = {
        account_id: account.id,
        platform: account.platform,
        external_account_id: account.externalAccountId,
        configured,
        daily_rows: 0,
        creatives: 0,
        error: undefined as string | undefined,
      };

      if (!configured) {
        // fail-closed: sem token, não escreve. Marca o motivo na conta.
        entry.error = 'sem credencial no ENV (fail-closed)';
        await this.markAccount(account.id, { error: entry.error });
        result.accounts.push(entry);
        continue;
      }

      try {
        const daily = await client.fetchDailyInsights(
          workspaceId,
          account.externalAccountId,
          range.startDay,
          range.endDay,
        );
        // insere/reescreve o lado reportado (ReplacingMergeTree colapsa re-sync).
        await insertCreativeDaily(daily as unknown as Array<Record<string, unknown>>);
        entry.daily_rows = daily.length;

        const metas = await client.fetchCreatives(account.externalAccountId);
        await this.upsertCreatives(workspaceId, metas);
        entry.creatives = metas.length;

        await this.markAccount(account.id, { cursor: range.endDay, syncedAt: new Date() });
        result.total_daily_rows += daily.length;
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`sync falhou (account=${account.id}): ${entry.error}`);
        await this.markAccount(account.id, { error: entry.error });
      }
      result.accounts.push(entry);
    }

    return result;
  }

  private async markAccount(
    id: string,
    patch: { cursor?: string; syncedAt?: Date; error?: string },
  ): Promise<void> {
    const set: Partial<CreativeAdAccount> = { updatedAt: new Date() };
    if (patch.cursor !== undefined) set.syncCursor = patch.cursor;
    if (patch.syncedAt !== undefined) {
      set.lastSyncedAt = patch.syncedAt;
      set.status = 'active';
      set.lastError = null;
    }
    if (patch.error !== undefined) {
      set.lastError = patch.error;
      set.status = 'error';
    }
    await this.db.update(creativeAdAccounts).set(set).where(eq(creativeAdAccounts.id, id));
  }

  /** Upsert do cache de metadados (idempotente por PK composta). */
  private async upsertCreatives(workspaceId: string, metas: CreativeMeta[]): Promise<void> {
    if (metas.length === 0) return;
    const now = new Date();
    for (const m of metas) {
      const values = {
        workspaceId,
        platform: m.platform,
        adId: m.adId,
        adName: m.adName,
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        adsetId: m.adsetId,
        adsetName: m.adsetName,
        creativeType: m.creativeType,
        phase: m.phase,
        thumbnailUrl: m.thumbnailUrl,
        previewUrl: m.previewUrl,
        adStatus: m.adStatus,
        landingUrl: m.landingUrl,
        raw: m.raw,
        firstSeenAt: now,
        lastSyncedAt: now,
      };
      await this.db
        .insert(creatives)
        .values(values)
        .onConflictDoUpdate({
          target: [creatives.workspaceId, creatives.platform, creatives.adId],
          set: {
            adName: values.adName,
            campaignId: values.campaignId,
            campaignName: values.campaignName,
            adsetId: values.adsetId,
            adsetName: values.adsetName,
            creativeType: values.creativeType,
            phase: values.phase,
            thumbnailUrl: values.thumbnailUrl,
            previewUrl: values.previewUrl,
            adStatus: values.adStatus,
            landingUrl: values.landingUrl,
            raw: values.raw,
            lastSyncedAt: now,
          },
        });
    }
  }
}
