import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { IdentityModule } from './modules/identity/identity.module';
import { DataQualityModule } from './modules/data-quality/data-quality.module';
import { FunnelsModule } from './modules/funnels/funnels.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { AttributionModule } from './modules/attribution/attribution.module';
import { DataExplorerModule } from './modules/data-explorer/data-explorer.module';
import { ProfilesModule } from './modules/profiles/profiles.module';

@Module({
  imports: [
    HealthModule,
    AuthModule,
    EventsModule,
    TrackingModule,
    WebhooksModule,
    IdentityModule,
    DataQualityModule,
    FunnelsModule,
    MetricsModule,
    AttributionModule,
    DataExplorerModule,
    ProfilesModule,
  ],
})
export class AppModule {}
