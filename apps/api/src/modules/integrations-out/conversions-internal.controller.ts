import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InternalAuthGuard } from '../identity/guards/internal-auth.guard';
import {
  ConversionForwarderService,
  type ConversionForwardInput,
} from './conversion-forwarder.service';
import { internalForwardSchema, type InternalForwardDto } from './dto/internal-forward.dto';

/**
 * M9 — endpoint INTERNO (server-to-server) de forward de conversão. Fecha o wiring
 * M2×M9: o consumer do stream de eventos chama aqui em cada conversão (purchase/
 * lead/…), com a PII viva já normalizada, para o envio server-side às plataformas
 * habilitadas do workspace.
 *
 * Auth: InternalAuthGuard (segredo compartilhado `INTERNAL_API_SECRET`), NÃO JWT —
 * mesmo padrão do /v1/internal/identity/identify (M8). `forward()` é fail-closed:
 * sem plataforma habilitada / sem consentimento / sem match key, não envia nada.
 */
@Controller('v1/internal/conversions')
@UseGuards(InternalAuthGuard)
export class ConversionsInternalController {
  constructor(private readonly forwarder: ConversionForwarderService) {}

  @Post('forward')
  @HttpCode(200)
  forward(@Body(new ZodValidationPipe(internalForwardSchema)) dto: InternalForwardDto) {
    // A forma do DTO espelha ConversionForwardInput (platforms é validado como
    // string[]; o service filtra pelo conjunto habilitado).
    return this.forwarder.forward(dto as unknown as ConversionForwardInput);
  }
}
