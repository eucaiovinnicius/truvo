import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InsightsService } from './insights.service';
import { publicResolveQuerySchema, type PublicResolveQueryDto } from './dto/insight.dto';

/**
 * M16 — resolução PÚBLICA read-only de insights compartilhados. SEM auth e SEM
 * guard de workspace: o tenant é resolvido SERVER-SIDE pelo registro do share
 * (insight_shares.workspace_id), NUNCA a partir do request (segurança multi-tenant).
 *
 * Registrado ANTES do InsightsController (ver DataExplorerModule) para garantir que
 * `public/:token` (2 segmentos, 1º literal 'public') case antes de qualquer rota
 * dinâmica `:insightId/...`. Só shares ativos/não expirados resolvem.
 */
@Controller('v1/insights')
export class PublicInsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** GET /v1/insights/public/:token — renderiza o insight read-only (senha opcional). */
  @Get('public/:token')
  resolve(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(publicResolveQuerySchema)) q: PublicResolveQueryDto,
  ) {
    return this.insights.resolvePublic(token, q.password);
  }
}
