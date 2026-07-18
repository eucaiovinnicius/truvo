import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { EventsService } from './events.service';
import { volumeQuerySchema, type VolumeQueryDto } from './dto/query.dto';
import type { AuthenticatedRequest } from './types';

/**
 * Leitura de eventos p/ o painel (auth: JWT). Mesmo path base do controller de
 * ingestão — o Nest resolve por método/rota (GET recent|volume vs POST /). Toda
 * query filtra por `req.workspaceId` (regra 1).
 */
@Controller('v1/events')
@UseGuards(JwtAuthGuard)
export class EventsQueryController {
  constructor(private readonly events: EventsService) {}

  /** Debug view — últimos 50 eventos em tempo (quase) real. */
  @Get('recent')
  recent(@Req() req: AuthenticatedRequest) {
    return this.events.recent(req.workspaceId);
  }

  /** Volume chart — eventos por hora/dia. */
  @Get('volume')
  volume(
    @Query(new ZodValidationPipe(volumeQuerySchema)) q: VolumeQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.events.volume(req.workspaceId, q.granularity, q.start, q.end);
  }
}
