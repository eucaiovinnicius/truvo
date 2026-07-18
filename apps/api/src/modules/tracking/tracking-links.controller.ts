import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TrackingService } from './tracking.service';
import { WorkspaceAuthGuard } from './guards/workspace-auth.guard';
import { CurrentWorkspace, type WorkspaceContext } from './guards/current-workspace.decorator';
import {
  createTrackingLinkSchema,
  updateTrackingLinkSchema,
  type CreateTrackingLinkDto,
  type UpdateTrackingLinkDto,
} from './dto/tracking-link.dto';

/**
 * CRUD + stats de tracking links (PRD §7 M3). Auth por JWT do Supabase; todo acesso é
 * escopado ao workspace resolvido no header `x-workspace-id` (regra 1).
 */
@Controller('v1/tracking/links')
@UseGuards(WorkspaceAuthGuard)
export class TrackingLinksController {
  constructor(private readonly tracking: TrackingService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.tracking.list(ws.id);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body(new ZodValidationPipe(createTrackingLinkSchema)) dto: CreateTrackingLinkDto,
  ) {
    return this.tracking.create(ws.id, dto);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.tracking.get(ws.id, id);
  }

  @Get(':id/stats')
  stats(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.tracking.stats(ws.id, id);
  }

  @Patch(':id')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTrackingLinkSchema)) dto: UpdateTrackingLinkDto,
  ) {
    return this.tracking.update(ws.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.tracking.remove(ws.id, id);
  }
}
