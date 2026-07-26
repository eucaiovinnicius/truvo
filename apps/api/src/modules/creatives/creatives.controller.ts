import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import { FeatureGuard } from '../billing/feature.guard';
import { RequireFeature } from '../billing/feature.decorator';
import type { CreativePlatform } from '@truvo/db';
import { CreativesService } from './creatives.service';
import { CreativeAlertsService } from './creative-alerts.service';
import { AdsService } from './ads/ads.service';
import type { CreativeOrderBy } from './creatives.constants';
import {
  accountBodySchema,
  alertsQuerySchema,
  compareQuerySchema,
  detailQuerySchema,
  gridQuerySchema,
  scorecardQuerySchema,
  syncBodySchema,
  type AccountBodyDto,
  type AlertsQueryDto,
  type CompareQueryDto,
  type DetailQueryDto,
  type GridQueryDto,
  type ScorecardQueryDto,
  type SyncBodyDto,
} from './dto/creatives-query.dto';

/**
 * M10 — CREATIVE ANALYTICS (PRD §7 M10). Cruza o REPORTADO pelas Ads APIs com as
 * conversões REAIS do Truvo e expõe o DELTA por criativo.
 *
 * Auth (reuso do M1): SupabaseAuthGuard (autentica) + WorkspaceGuard (resolve o
 * tenant). Nenhuma rota tem param `:id` de workspace → o WorkspaceGuard resolve
 * SEMPRE pelo header `x-workspace-id` (regra 1). `:adId` é recurso, não tenant.
 *
 * Ordem das rotas: as estáticas (`alerts`/`compare`/`accounts`/`sync`) vêm ANTES de
 * `:adId` para não serem capturadas como um id.
 */
@Controller('v1/creatives')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard, FeatureGuard)
@RequireFeature('creative_analytics')
export class CreativesController {
  constructor(
    private readonly creatives: CreativesService,
    private readonly alerts: CreativeAlertsService,
    private readonly ads: AdsService,
  ) {}

  /** GET /v1/creatives — grid/tabela com filtros e ordenação. */
  @Get()
  grid(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(gridQuerySchema)) q: GridQueryDto,
  ) {
    return this.creatives.getGrid(workspaceId, {
      platform: q.platform,
      campaign_id: q.campaign_id,
      type: q.type,
      phase: q.phase,
      order_by: q.order_by as CreativeOrderBy | undefined,
      order_dir: q.order_dir,
      start: q.start,
      end: q.end,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** GET /v1/creatives/alerts — fadiga/discrepância/top/gasto-sem-conversão (via M12). */
  @Get('alerts')
  getAlerts(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(alertsQuerySchema)) q: AlertsQueryDto,
  ) {
    return this.alerts.getAlerts(workspaceId, {
      platform: q.platform,
      start: q.start,
      end: q.end,
      persist: q.persist,
    });
  }

  /** GET /v1/creatives/compare?ad_ids=id1,id2,id3 — 2 a 4 criativos side-by-side. */
  @Get('compare')
  compare(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(compareQuerySchema)) q: CompareQueryDto,
  ) {
    return this.creatives.compare(workspaceId, q.ad_ids, {
      platform: q.platform,
      start: q.start,
      end: q.end,
    });
  }

  /** GET /v1/creatives/accounts — contas de anúncio conectadas ao workspace. */
  @Get('accounts')
  async listAccounts(@CurrentWorkspace('id') workspaceId: string) {
    const rows = await this.ads.listAccounts(workspaceId);
    return {
      any_platform_configured: this.ads.anyConfigured(),
      accounts: rows.map((a) => ({
        id: a.id,
        platform: a.platform,
        external_account_id: a.externalAccountId,
        name: a.name,
        status: a.status,
        sync_cursor: a.syncCursor,
        last_synced_at: a.lastSyncedAt,
        last_error: a.lastError,
      })),
    };
  }

  /** POST /v1/creatives/accounts — conecta/re-ativa uma conta de anúncio. */
  @Post('accounts')
  @Roles('owner', 'admin', 'member')
  async connectAccount(
    @CurrentWorkspace('id') workspaceId: string,
    @Body(new ZodValidationPipe(accountBodySchema)) dto: AccountBodyDto,
  ) {
    const acc = await this.ads.upsertAccount(workspaceId, {
      platform: dto.platform as CreativePlatform,
      externalAccountId: dto.external_account_id,
      name: dto.name,
      config: dto.config,
    });
    return {
      id: acc.id,
      platform: acc.platform,
      external_account_id: acc.externalAccountId,
      name: acc.name,
      status: acc.status,
    };
  }

  /** POST /v1/creatives/sync — dispara o sync das Ads APIs (fail-closed sem token). */
  @Post('sync')
  @Roles('owner', 'admin', 'member')
  sync(
    @CurrentWorkspace('id') workspaceId: string,
    @Body(new ZodValidationPipe(syncBodySchema)) dto: SyncBodyDto,
  ) {
    return this.ads.syncWorkspace(workspaceId, {
      platform: dto.platform as CreativePlatform | undefined,
      start: dto.start,
      end: dto.end,
    });
  }

  /** GET /v1/creatives/:adId/scorecard — payload exportável (PNG/PDF/link). */
  @Get(':adId/scorecard')
  scorecard(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('adId') adId: string,
    @Query(new ZodValidationPipe(scorecardQuerySchema)) q: ScorecardQueryDto,
  ) {
    return this.creatives.scorecard(workspaceId, adId, {
      platform: q.platform,
      start: q.start,
      end: q.end,
    });
  }

  /** GET /v1/creatives/:adId — sheet de detalhe (métricas + funil + série + jornada). */
  @Get(':adId')
  detail(
    @CurrentWorkspace('id') workspaceId: string,
    @Param('adId') adId: string,
    @Query(new ZodValidationPipe(detailQuerySchema)) q: DetailQueryDto,
  ) {
    return this.creatives.getDetail(workspaceId, adId, {
      platform: q.platform,
      start: q.start,
      end: q.end,
      buyers_limit: q.buyers_limit,
    });
  }
}
