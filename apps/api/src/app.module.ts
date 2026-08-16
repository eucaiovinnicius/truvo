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
import { NotificationsModule } from './modules/notifications/notifications.module';
import { IntegrationsOutModule } from './modules/integrations-out/integrations-out.module';
import { CreativesModule } from './modules/creatives/creatives.module';
import { AiModule } from './modules/ai/ai.module';
import { ReportsModule } from './modules/reports/reports.module';
import { BillingModule } from './modules/billing/billing.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { CustomerContextModule } from './modules/customer-context/customer-context.module';
import { AuditModule } from './modules/audit/audit.module';
import { DataLifecycleModule } from './modules/data-lifecycle/data-lifecycle.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';

@Module({
  imports: [
    HealthModule,
    AuthModule,
    AuditModule, // @Global — registrar cedo (Order 035 §4)
    EventsModule,
    TrackingModule,
    WebhooksModule,
    IdentityModule,
    CustomerContextModule,
    DataLifecycleModule, // Order 035 §5 — depende de CustomerContextModule
    ConnectorsModule, // Order 050 — provider-neutral connector framework
    DataQualityModule,
    FunnelsModule,
    MetricsModule,
    AttributionModule,
    DataExplorerModule,
    ProfilesModule,
    // Onda 4 (final)
    NotificationsModule, // @Global — registrar cedo
    IntegrationsOutModule, // M9
    CreativesModule, // M10 (fornece AD_SPEND_PROVIDER / PLATFORM_METRICS_PROVIDER)
    AiModule, // M17
    ReportsModule, // M13
    BillingModule, // M11
    SchedulerModule, // crons (leader-lock) — sweeps de billing/alertas/reconc/ads-sync
  ],
})
export class AppModule {}
