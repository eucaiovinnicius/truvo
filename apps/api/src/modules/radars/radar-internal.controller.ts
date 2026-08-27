import { Body, Controller, Headers, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InternalAuthGuard } from '../identity/guards/internal-auth.guard';
import { RadarService } from './radar.service';

const resultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'insufficient_data']),
  modelReference: z.string().trim().min(1).max(200).optional(),
  failureCategory: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  failureReason: z.string().max(500).optional(),
}).strict();
type ResultDto = z.infer<typeof resultSchema>;

@Controller('v1/internal/radars')
@UseGuards(InternalAuthGuard)
export class RadarInternalController {
  constructor(private readonly radars: RadarService) {}

  @Post(':radarId/definitions/:version/training-requests/:requestId/result')
  @HttpCode(200)
  report(
    @Headers('x-workspace-id') workspaceId: string,
    @Param('radarId') radarId: string,
    @Param('version', ParseIntPipe) version: number,
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(resultSchema)) body: ResultDto,
  ) {
    return this.radars.reportTrainingResult(workspaceId, radarId, version, requestId, body);
  }
}
