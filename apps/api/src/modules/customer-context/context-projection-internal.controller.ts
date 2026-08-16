import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InternalAuthGuard } from '../identity/guards/internal-auth.guard';
import { EventProjectionService } from './event-projection.service';
import { internalProjectSchema, type InternalProjectDto } from './dto/context-projection.dto';

/**
 * Order 040 — endpoint INTERNO (server-to-server) de projeção evento→contexto
 * canônico. Fecha o wiring M2×Order 30: o consumer chama isto DEPOIS de um
 * identify() bem-sucedido (que já resolveu `canonical_id`), em cada evento aceito
 * que tenha uma regra de projeção conhecida (ver `outcome-projection.registry.ts`).
 *
 * Auth: InternalAuthGuard (segredo compartilhado `INTERNAL_API_SECRET`), NÃO JWT —
 * mesmo padrão de `/v1/internal/identity/identify` e `/v1/internal/conversions/forward`.
 */
@Controller('v1/internal/context')
@UseGuards(InternalAuthGuard)
export class ContextProjectionInternalController {
  constructor(private readonly projection: EventProjectionService) {}

  @Post('project')
  @HttpCode(200)
  project(@Body(new ZodValidationPipe(internalProjectSchema)) dto: InternalProjectDto) {
    return this.projection.project(dto.workspace_id, dto.canonical_id, dto.event);
  }
}
