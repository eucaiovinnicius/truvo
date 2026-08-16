import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { createHubspotAdapter } from './hubspot.adapter';

/** Order 061 §1 — registers the real, BIDIRECTIONAL HubSpot adapter (source +
 * destination) into the Connector Framework registry at module init — same
 * pattern as `ShopifyBootstrapService` (Order 060), just registering both roles
 * since `createHubspotAdapter()` implements `SourceAdapter & DestinationAdapter`. */
@Injectable()
export class HubspotBootstrapService implements OnModuleInit {
  constructor(private readonly registry: ConnectorRegistryService) {}

  onModuleInit(): void {
    const adapter = createHubspotAdapter();
    this.registry.registerSource(adapter);
    this.registry.registerDestination(adapter);
  }
}
