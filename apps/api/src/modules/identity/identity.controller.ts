import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentWorkspace } from '../auth/decorators';
import { FeatureGuard } from '../billing/feature.guard';
import { RequireFeature } from '../billing/feature.decorator';
import { IdentityService } from './identity.service';
import {
  identifySchema,
  lookupQuerySchema,
  mergesQuerySchema,
  type IdentifyDto,
  type LookupQueryDto,
  type MergesQueryDto,
} from './dto/identity.dto';

/**
 * M8 — Identity Resolution (PRD §7 M8 "Endpoints").
 *
 * Protegido por SupabaseAuthGuard (autenticação) + WorkspaceGuard (autorização
 * multi-tenant). Sem `:id` na rota, o WorkspaceGuard resolve o workspace pelo
 * header `x-workspace-id` e injeta `request.workspace`. TODA operação é escopada
 * por `workspace_id` (regra 1) — identidades NUNCA cruzam workspaces.
 */
@Controller('v1/identity')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard, FeatureGuard)
@RequireFeature('identity_resolution')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /** GET /v1/identity/lookup?identifier=&type= — resolve identificador → grafo fundido. */
  @Get('lookup')
  lookup(
    @Query(new ZodValidationPipe(lookupQuerySchema)) q: LookupQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.identity.lookup(workspaceId, q.identifier, q.type);
  }

  /** POST /v1/identity/identify — trigger de stitching (merge anon → user via email_hash). */
  @Post('identify')
  @HttpCode(200)
  identify(
    @Body(new ZodValidationPipe(identifySchema)) dto: IdentifyDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.identity.identify(workspaceId, dto);
  }

  /** GET /v1/identity/merges — histórico de fusões do workspace (paginado). */
  @Get('merges')
  merges(
    @Query(new ZodValidationPipe(mergesQuerySchema)) q: MergesQueryDto,
    @CurrentWorkspace('id') workspaceId: string,
  ) {
    return this.identity.listMerges(workspaceId, q);
  }
}
