import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, type AuthUser } from '../auth/decorators';
import { ProfilesService } from './profiles.service';
import {
  journeyQuerySchema,
  searchQuerySchema,
  timelineQuerySchema,
  type JourneyQueryDto,
  type SearchQueryDto,
  type TimelineQueryDto,
} from './dto/profiles.dto';

/**
 * M15 — CUSTOMER PROFILE / USER 360 (PRD §7 M15 "Endpoints").
 *
 * Auth (reuso do M1 @Global): SupabaseAuthGuard (autentica → request.user) +
 * WorkspaceGuard (resolve o tenant + membership). SEM `:id` na rota, o WorkspaceGuard
 * resolve o workspace pelo header `x-workspace-id` (o parâmetro de rota é
 * `:canonicalId`, que NÃO deve colidir com o id do workspace). TODA operação é
 * escopada por workspace_id (regra 1/20) — perfis NUNCA cruzam tenants.
 *
 * `@CurrentUser()` é passado ao service para a trilha de auditoria LGPD
 * (profile_access_log — regra 20): todo acesso a um perfil individual é registrado.
 *
 * Leitura apenas: sem @Roles — qualquer membro do workspace (inclusive viewer) pode
 * consultar perfis; a auditoria registra quem acessou. // TODO(live): se o produto
 * exigir gate de plano (user_360, Growth+) ou papel mínimo, plugar aqui.
 */
@Controller('v1/profiles')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  /** GET /v1/profiles/search?q=&type= — busca por 1 dos 5 tipos de identificador. */
  @Get('search')
  search(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQueryDto,
  ) {
    return this.profiles.search(workspaceId, query, user);
  }

  /** GET /v1/profiles/:canonicalId — perfil consolidado (cabeçalho + métricas). */
  @Get(':canonicalId')
  getProfile(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Param('canonicalId') canonicalId: string,
  ) {
    return this.profiles.getProfile(workspaceId, canonicalId, user);
  }

  /** GET /v1/profiles/:canonicalId/timeline — eventos (cursor, filtros, group_by=day). */
  @Get(':canonicalId/timeline')
  getTimeline(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Param('canonicalId') canonicalId: string,
    @Query(new ZodValidationPipe(timelineQuerySchema)) query: TimelineQueryDto,
  ) {
    return this.profiles.getTimeline(workspaceId, canonicalId, query, user);
  }

  /** GET /v1/profiles/:canonicalId/identities — identificadores + devices + merges. */
  @Get(':canonicalId/identities')
  getIdentities(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Param('canonicalId') canonicalId: string,
  ) {
    return this.profiles.getIdentities(workspaceId, canonicalId, user);
  }

  /** GET /v1/profiles/:canonicalId/journey?model=&window= — jornada de conversão. */
  @Get(':canonicalId/journey')
  getJourney(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Param('canonicalId') canonicalId: string,
    @Query(new ZodValidationPipe(journeyQuerySchema)) query: JourneyQueryDto,
  ) {
    return this.profiles.getJourney(workspaceId, canonicalId, query, user);
  }
}
