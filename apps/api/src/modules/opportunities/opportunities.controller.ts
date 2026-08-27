import { Body, Controller, Get, Param, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import type { OpportunityQuery, OpportunitySelection } from './opportunity-contracts';
import { OpportunitiesService } from './opportunities.service';

function number(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function boolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function queryOptions(query: Record<string, string | undefined>): OpportunityQuery & { cursor?: string; limit?: number } {
  const trait = query.traitNamespace && query.traitKey && query.traitValue !== undefined
    ? { namespace: query.traitNamespace, key: query.traitKey, value: query.traitValue }
    : undefined;
  return {
    sort: query.sort as OpportunityQuery['sort'],
    direction: query.direction as OpportunityQuery['direction'],
    cursor: query.cursor,
    limit: number(query.limit),
    filters: {
      scoreBands: query.scoreBands?.split(',').filter(Boolean) as Array<'high' | 'medium' | 'low'> | undefined,
      probabilityMin: number(query.probabilityMin),
      probabilityMax: number(query.probabilityMax),
      monetary: boolean(query.monetary),
      currency: query.currency,
      expectedRevenueMin: query.expectedRevenueMin,
      expectedRevenueMax: query.expectedRevenueMax,
      recentActivityAfter: query.recentActivityAfter,
      trait,
    },
  };
}

@Controller('v1/opportunities')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get('summary')
  summary(@CurrentWorkspace('id') workspaceId: string, @Query('radarId') radarId: string) {
    return this.opportunities.summary(workspaceId, radarId);
  }

  @Get('reconciliation')
  reconciliation(@CurrentWorkspace('id') workspaceId: string, @Query('radarId') radarId: string) {
    return this.opportunities.reconcile(workspaceId, radarId);
  }

  @Post('materialize')
  @Roles('owner', 'admin')
  materialize(@CurrentWorkspace('id') workspaceId: string, @Body() body: { radarId: string }) {
    return this.opportunities.materialize(workspaceId, body.radarId);
  }

  @Post('export')
  async export(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') actorUserId: string | undefined,
    @Body() body: { radarId: string; selection: OpportunitySelection; correlationId: string },
  ) {
    const result = await this.opportunities.exportCsv(workspaceId, actorUserId, body);
    return new StreamableFile(Buffer.from(result.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="revenue-opportunities-${result.id}.csv"`,
      length: Buffer.byteLength(result.csv),
    });
  }

  @Post('activation/preview')
  preview(
    @CurrentWorkspace('id') workspaceId: string,
    @Body() body: { radarId: string; selection: OpportunitySelection; correlationId: string; connectionId: string; idempotencyKey: string },
  ) {
    return this.opportunities.previewActivation(workspaceId, body);
  }

  @Post('activation')
  activate(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('id') actorUserId: string | undefined,
    @Body() body: { radarId: string; selection: OpportunitySelection; correlationId: string; connectionId: string; idempotencyKey: string },
  ) {
    return this.opportunities.activate(workspaceId, actorUserId, body);
  }

  @Get()
  list(
    @CurrentWorkspace('id') workspaceId: string,
    @Query('radarId') radarId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.opportunities.list(workspaceId, radarId, queryOptions(query));
  }

  @Get(':id')
  detail(@CurrentWorkspace('id') workspaceId: string, @Param('id') id: string) {
    return this.opportunities.detail(workspaceId, id);
  }
}
