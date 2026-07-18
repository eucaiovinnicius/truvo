import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import { INTEGRATION_OUT_PLATFORMS, type IntegrationOutPlatform } from '@truvo/db';
import { IntegrationOutConfigService } from './config.service';
import { ConversionForwarderService } from './conversion-forwarder.service';
import {
  logsQuerySchema,
  platformParamSchema,
  testConversionSchema,
  upsertConfigSchema,
  type LogsQuery,
  type TestConversionDto,
  type UpsertConfigDto,
} from './dto/integrations-out.dto';

/**
 * M9 — EXTERNAL INTEGRATIONS (saída) · API (PRD §7 M9).
 *
 * Rotas de gerência da saída de conversões (Meta CAPI / Google Enhanced / TikTok
 * Events) por workspace. Auth reusa o M1 (@Global AuthModule): SupabaseAuthGuard
 * (autentica) + WorkspaceGuard (resolve tenant via header x-workspace-id, regra 1).
 *
 * Permissões (M1): ler status/logs = qualquer papel (viewer+); mutações
 * (config/test) = manageIntegrations → owner/admin (@Roles).
 *
 * NOTA: o ENVIO real de conversões NÃO acontece aqui — é disparado pelo
 * ConversionForwarderService no fluxo de conversão (consumer/M8). Estas rotas
 * configuram, testam e monitoram (Event Match Quality).
 */
@Controller('v1/integrations-out')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class IntegrationsOutController {
  constructor(
    private readonly configs: IntegrationOutConfigService,
    private readonly forwarder: ConversionForwarderService,
  ) {}

  /** GET /v1/integrations-out/status — status + EMQ de TODAS as plataformas. */
  @Get('status')
  async status(@CurrentWorkspace('id') workspaceId: string) {
    const existing = await this.configs.list(workspaceId);
    const byPlatform = new Map(existing.map((c) => [c.platform, c]));

    const platforms = await Promise.all(
      INTEGRATION_OUT_PLATFORMS.map(async (platform) => {
        const cfg = byPlatform.get(platform);
        const stats = cfg
          ? await this.forwarder.stats(workspaceId, platform)
          : { sent: 0, failed: 0, skipped: 0, avgMatchQuality: null, byStatus: {} };
        return {
          platform,
          configured: Boolean(cfg),
          enabled: cfg?.enabled ?? false,
          has_credentials: cfg?.hasCredentials ?? false,
          status: cfg?.status ?? 'not_configured',
          consent_required: cfg?.consentRequired ?? true,
          last_error: cfg?.lastError ?? null,
          last_forward_at:
            cfg?.lastForwardAt instanceof Date
              ? cfg.lastForwardAt.toISOString()
              : (cfg?.lastForwardAt ?? null),
          stats,
        };
      }),
    );
    return { platforms };
  }

  /** GET /v1/integrations-out/:platform — config pública + stats de uma plataforma. */
  @Get(':platform')
  async getOne(
    @CurrentWorkspace('id') workspaceId: string,
    @Param(new ZodValidationPipe(platformParamSchema)) params: { platform: IntegrationOutPlatform },
  ) {
    const cfg = await this.configs.getPublic(workspaceId, params.platform);
    const stats = await this.forwarder.stats(workspaceId, params.platform);
    return { platform: params.platform, config: cfg, stats };
  }

  /** PUT /v1/integrations-out/:platform — cria/atualiza config + credenciais (upsert). */
  @Put(':platform')
  @Roles('owner', 'admin')
  async upsert(
    @CurrentWorkspace('id') workspaceId: string,
    @Param(new ZodValidationPipe(platformParamSchema)) params: { platform: IntegrationOutPlatform },
    @Body(new ZodValidationPipe(upsertConfigSchema)) dto: UpsertConfigDto,
  ) {
    return this.configs.upsert(workspaceId, params.platform, dto);
  }

  /** DELETE /v1/integrations-out/:platform — remove a config da plataforma. */
  @Delete(':platform')
  @Roles('owner', 'admin')
  async remove(
    @CurrentWorkspace('id') workspaceId: string,
    @Param(new ZodValidationPipe(platformParamSchema)) params: { platform: IntegrationOutPlatform },
  ) {
    await this.configs.remove(workspaceId, params.platform);
    return { ok: true };
  }

  /**
   * POST /v1/integrations-out/:platform/test — valida credenciais e (se houver match
   * keys no corpo) envia uma conversão de teste (test_event_code). Owner/admin.
   */
  @Post(':platform/test')
  @Roles('owner', 'admin')
  async test(
    @CurrentWorkspace('id') workspaceId: string,
    @Param(new ZodValidationPipe(platformParamSchema)) params: { platform: IntegrationOutPlatform },
    @Body(new ZodValidationPipe(testConversionSchema)) dto: TestConversionDto,
  ) {
    return this.forwarder.test(workspaceId, params.platform, {
      eventName: dto.event_name,
      value: dto.value,
      currency: dto.currency,
      email: dto.email,
      phone: dto.phone,
      clickId: dto.click_id,
      externalId: dto.external_id,
    });
  }

  /** GET /v1/integrations-out/:platform/logs — monitor de EMQ / auditoria de envios. */
  @Get(':platform/logs')
  async logs(
    @CurrentWorkspace('id') workspaceId: string,
    @Param(new ZodValidationPipe(platformParamSchema)) params: { platform: IntegrationOutPlatform },
    @Query(new ZodValidationPipe(logsQuerySchema)) q: LogsQuery,
  ) {
    return this.forwarder.recentLogs(workspaceId, params.platform, {
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    });
  }
}
