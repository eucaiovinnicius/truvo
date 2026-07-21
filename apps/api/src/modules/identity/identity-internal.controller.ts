import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InternalAuthGuard } from './guards/internal-auth.guard';
import { IdentityService } from './identity.service';
import { internalIdentifySchema, type InternalIdentifyDto } from './dto/identity.dto';

/**
 * M8 — endpoint INTERNO (server-to-server) de identify. Fecha o wiring M2×M8: o
 * consumer do stream de eventos chama aqui para construir o grafo de identidade a
 * partir de cada evento com identificador (purchase/user_id/order_id/...).
 *
 * Auth: InternalAuthGuard (segredo compartilhado `INTERNAL_API_SECRET`), NÃO JWT.
 * O `workspace_id` vem no corpo (o consumer já o resolveu do evento — a API key da
 * ingestão o autenticou no M2). Toda a lógica de merge/dedup é a mesma do endpoint
 * público, incluindo o enfileiramento do stitching retroativo.
 */
@Controller('v1/internal/identity')
@UseGuards(InternalAuthGuard)
export class IdentityInternalController {
  constructor(private readonly identity: IdentityService) {}

  @Post('identify')
  @HttpCode(200)
  identify(@Body(new ZodValidationPipe(internalIdentifySchema)) dto: InternalIdentifyDto) {
    return this.identity.identify(dto.workspace_id, dto);
  }
}
