import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { createShopifyAdapter } from './shopify.adapter';

/** Order 060 §1 — registers the real Shopify adapter into the Connector Framework
 * registry at module init, the SAME pattern the fake provider's own contract-kit
 * tests use (`registry.registerSource(...)`), just wired via Nest lifecycle instead
 * of being called directly by a test. */
@Injectable()
export class ShopifyBootstrapService implements OnModuleInit {
  constructor(private readonly registry: ConnectorRegistryService) {}

  onModuleInit(): void {
    this.registry.registerSource(createShopifyAdapter());
  }
}
