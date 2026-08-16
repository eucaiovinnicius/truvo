import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { CanonicalMappingService } from './canonical-mapping';
import { CommerceWriteService } from './commerce/commerce-write.service';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorDestinationService } from './connector-destination.service';
import { ConnectorWebhookService } from './connector-webhook.service';
import { ConnectorsController, ConnectorWebhooksController } from './connectors.controller';
import { ShopifyBootstrapService } from './adapters/shopify/shopify.bootstrap';

/**
 * Order 050 stood this module up service-only, deferring the HTTP surface and any
 * real provider adapter. Order 060 closes both deferrals: `ConnectorsController` /
 * `ConnectorWebhooksController` are the minimum provider-neutral routes, and
 * `ShopifyBootstrapService` registers the first real `SourceAdapter` at module
 * init — the SAME registry/orchestrator/webhook/mapping services, unchanged.
 */
@Module({
  imports: [IdentityModule, CustomerContextModule],
  controllers: [ConnectorsController, ConnectorWebhooksController],
  providers: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    CommerceWriteService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
    ShopifyBootstrapService,
  ],
  exports: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    CommerceWriteService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
  ],
})
export class ConnectorsModule {}
