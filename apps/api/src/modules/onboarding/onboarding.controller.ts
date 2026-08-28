import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { createFirstRadarSchema, linkConnectionSchema, onboardingReadinessSchema, selectPathSchema, startOnboardingSchema, type CreateFirstRadarDto, type SelectPathDto } from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@Controller('v1/onboarding') @UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}
  @Get() get(@CurrentWorkspace('id') ws: string) { return this.onboarding.get(ws); }
  @Post('start') @Roles('owner','admin','member') start(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string, @Body(new ZodValidationPipe(startOnboardingSchema)) body: { workspaceName?: string }) { return this.onboarding.start(ws, user, body.workspaceName); }
  @Post('path') @Roles('owner','admin','member') path(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string, @Body(new ZodValidationPipe(selectPathSchema)) body: SelectPathDto) { return this.onboarding.selectPath(ws, user, body); }
  @Post('connection') @Roles('owner','admin','member') connection(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string, @Body(new ZodValidationPipe(linkConnectionSchema)) body: { connectionId: string }) { return this.onboarding.linkConnection(ws, user, body.connectionId); }
  @Post('verify') @Roles('owner','admin','member') verify(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string) { return this.onboarding.verifyData(ws, user); }
  @Post('readiness') @Roles('owner','admin','member') readiness(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string, @Body(new ZodValidationPipe(onboardingReadinessSchema)) body: Record<string, unknown>) { return this.onboarding.readiness(ws, user, body); }
  @Post('radar') @Roles('owner','admin','member') radar(@CurrentWorkspace('id') ws: string, @CurrentUser('id') user: string, @Body(new ZodValidationPipe(createFirstRadarSchema)) body: CreateFirstRadarDto) { return this.onboarding.createFirstRadar(ws, user, body); }
}
