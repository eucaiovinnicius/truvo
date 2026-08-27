import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators'; import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard'; import { WorkspaceGuard } from '../auth/guards/workspace.guard'; import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RadarService } from './radar.service'; import { createRadarSchema, patchRadarSchema, trainRadarSchema, type CreateRadarDto, type PatchRadarDto, type TrainRadarDto } from './radar.dto';
import { modelLifecycleSchema } from './radar.dto'; import { ModelRegistryService } from './model-registry.service';
@Controller('v1/radars') @UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class RadarsController { constructor(private readonly radars: RadarService, private readonly models: ModelRegistryService) {}
  @Get('metadata/outcomes') outcomes(@CurrentWorkspace('id') ws:string) { return this.radars.availableOutcomes(ws); }
  @Get('metadata/audience') audienceMetadata() { return this.radars.audienceMetadata(); }
  @Get('metadata/destinations') destinations(@CurrentWorkspace('id') ws:string) { return this.radars.activationDestinations(ws); }
  @Post('metadata/readiness-preview') @Roles('owner','admin','member') previewReadiness(@CurrentWorkspace('id') ws: string, @Body(new ZodValidationPipe(createRadarSchema.omit({ name: true }))) body: Omit<CreateRadarDto, 'name'>) { return this.radars.previewReadiness(ws, body); }
  @Post() @Roles('owner','admin','member') create(@CurrentWorkspace('id') ws: string, @Body(new ZodValidationPipe(createRadarSchema)) body: CreateRadarDto) { return this.radars.create(ws, body); }
  @Get() list(@CurrentWorkspace('id') ws: string) { return this.radars.list(ws); }
  @Get(':id') get(@CurrentWorkspace('id') ws: string, @Param('id') id: string) { return this.radars.get(ws,id); }
  @Patch(':id') @Roles('owner','admin','member') patch(@CurrentWorkspace('id') ws:string,@Param('id') id:string,@Body(new ZodValidationPipe(patchRadarSchema)) body:PatchRadarDto){return this.radars.patch(ws,id,body);}
  @Post(':id/validate') @Roles('owner','admin','member') validate(@CurrentWorkspace('id')ws:string,@Param('id')id:string){return this.radars.validate(ws,id);}
  @Post(':id/train') @Roles('owner','admin','member') train(@CurrentWorkspace('id')ws:string,@Param('id')id:string,@Body(new ZodValidationPipe(trainRadarSchema))body:TrainRadarDto){return this.radars.train(ws,id,body.idempotencyKey);}
  @Get(':id/models') modelsList(@CurrentWorkspace('id') ws:string,@Param('id') id:string) { return this.models.list(ws,id); }
  @Get(':id/models/active') activeModel(@CurrentWorkspace('id') ws:string,@Param('id') id:string) { return this.models.active(ws,id); }
  @Get(':id/models/latest-training-run') latestTrainingRun(@CurrentWorkspace('id') ws:string,@Param('id') id:string) { return this.models.latestTrainingRun(ws,id); }
  @Get(':id/models/:modelId') modelDetail(@CurrentWorkspace('id') ws:string,@Param('id') id:string,@Param('modelId') modelId:string) { return this.models.detail(ws,id,modelId); }
  @Post(':id/models/:modelId/promote') @Roles('owner','admin') promote(@CurrentWorkspace('id') ws:string,@CurrentUser('id') userId:string,@Param('id') id:string,@Param('modelId') modelId:string,@Body(new ZodValidationPipe(modelLifecycleSchema)) body:{reason?:string}) { return this.models.promote(ws,id,modelId,userId,body.reason); }
  @Post(':id/models/:modelId/rollback') @Roles('owner','admin') rollback(@CurrentWorkspace('id') ws:string,@CurrentUser('id') userId:string,@Param('id') id:string,@Param('modelId') modelId:string,@Body(new ZodValidationPipe(modelLifecycleSchema)) body:{reason?:string}) { return this.models.rollback(ws,id,modelId,userId,body.reason); }
  @Post(':id/models/:modelId/retire') @Roles('owner','admin') retire(@CurrentWorkspace('id') ws:string,@CurrentUser('id') userId:string,@Param('id') id:string,@Param('modelId') modelId:string,@Body(new ZodValidationPipe(modelLifecycleSchema)) body:{reason?:string}) { return this.models.retire(ws,id,modelId,userId,body.reason); }
  @Post(':id/pause') @Roles('owner','admin','member') pause(@CurrentWorkspace('id')ws:string,@Param('id')id:string){return this.radars.action(ws,id,'paused');}
  @Post(':id/archive') @Roles('owner','admin','member') archive(@CurrentWorkspace('id')ws:string,@Param('id')id:string){return this.radars.action(ws,id,'archived');}
}
