import { Module } from '@nestjs/common';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { InternalAuthGuard } from '../identity/guards/internal-auth.guard';
import { RadarInternalController } from './radar-internal.controller';
import { RadarsController } from './radars.controller';
import { PropensityDispatchService } from './propensity-dispatch.service';
import { RadarService } from './radar.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelArtifactIntegrityService } from './model-artifact-integrity.service';

@Module({
  imports: [DataQualityModule, WebhooksModule],
  controllers: [RadarsController, RadarInternalController],
  providers: [RadarService, PropensityDispatchService, ModelRegistryService, ModelArtifactIntegrityService, InternalAuthGuard],
  exports: [RadarService, PropensityDispatchService, ModelRegistryService],
})
export class RadarsModule {}
