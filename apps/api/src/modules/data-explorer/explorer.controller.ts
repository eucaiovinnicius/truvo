import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { FeatureGuard } from '../billing/feature.guard';
import { RequireFeature } from '../billing/feature.decorator';
import { ExplorerService } from './explorer.service';
import { CatalogService } from './catalog.service';
import {
  catalogQuerySchema,
  explorerQueryBodySchema,
  propertiesQuerySchema,
  sqlBodySchema,
  valuesQuerySchema,
  type CatalogQueryDto,
  type ExplorerQueryBodyDto,
  type PropertiesQueryDto,
  type SqlBodyDto,
  type ValuesQueryDto,
} from './dto/explorer.dto';

/**
 * M16 — Data Explorer: execução (visual + SQL guardado) e catálogo.
 *
 * Auth (reuso do M1): SupabaseAuthGuard (autentica) + WorkspaceGuard (resolve o
 * tenant pelo header `x-workspace-id` — não há `:id` de rota aqui). O workspace
 * resolvido é a ÚNICA fonte de `workspace_id` do compilador (regra 19); o corpo
 * (spec) não o controla.
 *
 * O modo SQL guardado exige role owner|admin (M1) E o plano liberar `explorer_sql`
 * (Agency/Enterprise, M11) — via FeatureGuard + @RequireFeature nas rotas /sql*. As
 * demais rotas (visual/catálogo) não têm @RequireFeature → passam (explorer_visual
 * está em todos os planos).
 */
@Controller('v1/explorer')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard, FeatureGuard)
export class ExplorerController {
  constructor(
    private readonly explorer: ExplorerService,
    private readonly catalog: CatalogService,
  ) {}

  // ─────────────── execução visual (spec) ───────────────

  /** POST /v1/explorer/query — executa um ExplorerQuerySpec. */
  @Post('query')
  @HttpCode(200)
  query(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(explorerQueryBodySchema)) spec: ExplorerQueryBodyDto,
  ) {
    return this.explorer.executeSpec(workspaceId, userId, spec, 'query');
  }

  /** POST /v1/explorer/query/preview — execução amostrada/barata p/ o construtor. */
  @Post('query/preview')
  @HttpCode(200)
  preview(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(explorerQueryBodySchema)) spec: ExplorerQueryBodyDto,
  ) {
    return this.explorer.executeSpec(workspaceId, userId, spec, 'preview');
  }

  // ─────────────── modo SQL guardado (Agency/Enterprise, admin+) ───────────────

  /** POST /v1/explorer/sql/validate — parseia/allowlist (AST); NÃO executa. */
  @Post('sql/validate')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequireFeature('explorer_sql')
  validateSql(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(sqlBodySchema)) body: SqlBodyDto,
  ) {
    return this.explorer.validateSql(workspaceId, userId, body.sql);
  }

  /** POST /v1/explorer/sql — executa no sandbox read-only isolado. */
  @Post('sql')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequireFeature('explorer_sql')
  runSql(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(sqlBodySchema)) body: SqlBodyDto,
  ) {
    return this.explorer.runGuardedSql(workspaceId, userId, body.sql);
  }

  // ─────────────── catálogo ───────────────

  /** GET /v1/explorer/catalog — campos/dimensões/measures/operadores. */
  @Get('catalog')
  getCatalog(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(catalogQuerySchema)) q: CatalogQueryDto,
  ) {
    return this.catalog.getCatalog(workspaceId, q.source);
  }

  /** GET /v1/explorer/catalog/properties?event=purchase — propriedades amostradas. */
  @Get('catalog/properties')
  getProperties(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(propertiesQuerySchema)) q: PropertiesQueryDto,
  ) {
    return this.catalog.sampleProperties(workspaceId, q.event, q.days);
  }

  /** GET /v1/explorer/catalog/values?field=context.utm_source — autocomplete. */
  @Get('catalog/values')
  getValues(
    @CurrentWorkspace('id') workspaceId: string,
    @Query(new ZodValidationPipe(valuesQuerySchema)) q: ValuesQueryDto,
  ) {
    return this.catalog.getValues(workspaceId, q.field, q.source, q.limit);
  }
}
