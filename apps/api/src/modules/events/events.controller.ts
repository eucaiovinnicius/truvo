import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ApiKeyGuard } from './guards/api-key.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { EventsService } from './events.service';
import { apiIngestSchema, apiBatchSchema, type ApiIngestDto, type ApiBatchDto } from './dto/ingest.dto';
import type { AuthenticatedRequest } from './types';

/**
 * Ingestão de eventos (auth: X-Api-Key). Ordem dos guards: ApiKeyGuard resolve o
 * workspace → RateLimitGuard aplica o limite (regra 8). Ambos retornam 200 na
 * hora após publicar no Kafka (regra 9).
 */
@Controller('v1/events')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(200)
  ingest(
    @Body(new ZodValidationPipe(apiIngestSchema)) dto: ApiIngestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.events.ingestOne(dto, req.workspaceId);
  }

  @Post('batch')
  @HttpCode(200)
  ingestBatch(
    @Body(new ZodValidationPipe(apiBatchSchema)) dto: ApiBatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.events.ingestBatch(dto, req.workspaceId);
  }
}
