import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { CanonicalMappingService } from './canonical-mapping';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorDestinationService } from './connector-destination.service';
import { ConnectorWebhookService } from './connector-webhook.service';

/**
 * Order 050 — CONNECTOR FRAMEWORK. Service-only (no new HTTP controller): building
 * real provider adapters/routes is explicitly out of scope for this order, and
 * "adapt /v1/integrations where compatible instead of introducing competing
 * concepts" means this module must not stand up a parallel public surface that
 * nothing calls yet. Ready to be wired into a controller once Orders 60–63 add
 * real adapters — same posture Order 045 took for `IdentityGraphService`.
 */
@Module({
  imports: [IdentityModule, CustomerContextModule],
  providers: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
  ],
  exports: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
  ],
})
export class ConnectorsModule {}
