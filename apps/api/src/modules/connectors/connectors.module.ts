import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { CanonicalMappingService } from './canonical-mapping';
import { CommerceWriteService } from './commerce/commerce-write.service';
import { CrmWriteService } from './crm/crm-write.service';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorDestinationService } from './connector-destination.service';
import { ConnectorWebhookService } from './connector-webhook.service';
import { ConnectorsController, ConnectorWebhooksController } from './connectors.controller';
import { ShopifyBootstrapService } from './adapters/shopify/shopify.bootstrap';
import { HubspotBootstrapService } from './adapters/hubspot/hubspot.bootstrap';

/**
 * Order 050 stood this module up service-only, deferring the HTTP surface and any
 * real provider adapter. Order 060 closed both deferrals for Shopify (source-only).
 * Order 061 adds HubSpot as the first BIDIRECTIONAL adapter (source + destination
 * writeback) — the SAME registry/orchestrator/webhook/destination/mapping services,
 * unchanged.
 */
@Module({
  imports: [IdentityModule, CustomerContextModule],
  controllers: [ConnectorsController, ConnectorWebhooksController],
  providers: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    CommerceWriteService,
    CrmWriteService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
    ShopifyBootstrapService,
    HubspotBootstrapService,
  ],
  exports: [
    ConnectorRegistryService,
    ConnectorConnectionService,
    CanonicalMappingService,
    CommerceWriteService,
    CrmWriteService,
    ConnectorSyncOrchestratorService,
    ConnectorDestinationService,
    ConnectorWebhookService,
  ],
})
export class ConnectorsModule {}
