import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [HealthModule, AuthModule, EventsModule, TrackingModule, WebhooksModule],
})
export class AppModule {}
