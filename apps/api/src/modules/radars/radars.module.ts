import { Module } from '@nestjs/common';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { InternalAuthGuard } from '../identity/guards/internal-auth.guard';
import { RadarInternalController } from './radar-internal.controller';
import { RadarsController } from './radars.controller';
import { PropensityDispatchService } from './propensity-dispatch.service';
import { RadarService } from './radar.service';

@Module({
  imports: [DataQualityModule, WebhooksModule],
  controllers: [RadarsController, RadarInternalController],
  providers: [RadarService, PropensityDispatchService, InternalAuthGuard],
  exports: [RadarService, PropensityDispatchService],
})
export class RadarsModule {}
