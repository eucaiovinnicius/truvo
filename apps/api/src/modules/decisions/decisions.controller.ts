import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentWorkspace, Roles } from '../auth/decorators';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { DecisionsService } from './decisions.service';

@Controller('v1/decisions')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}
  @Get() list(@CurrentWorkspace('id') workspaceId: string, @Query('limit') limit?: string) { return this.decisions.list(workspaceId, Number(limit) || 50); }
  @Get(':id') detail(@CurrentWorkspace('id') workspaceId: string, @Param('id') id: string) { return this.decisions.detail(workspaceId, id); }
  @Get('learning/rows') @Roles('owner', 'admin') learning(@CurrentWorkspace('id') workspaceId: string, @Query() query: any) { return this.decisions.learningRows(workspaceId,{...query,limit:query.limit?Number(query.limit):undefined}); }
  @Post(':id/do-nothing') @Roles('owner', 'admin') nothing(@CurrentWorkspace('id') workspaceId: string, @Param('id') id: string, @Body() body: { correlationId: string }) { return this.decisions.recordDoNothing(workspaceId, id, body.correlationId); }
}
