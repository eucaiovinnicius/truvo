import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { createKlaviyoAdapter } from './klaviyo.adapter';

/** Order 063 — Klaviyo is bidirectional (source + destination), unlike Stripe
 * (source-only, `registerSource` only). Both registrations share the SAME
 * adapter instance, mirroring `HubspotBootstrapService`. */
@Injectable()
export class KlaviyoBootstrapService implements OnModuleInit {
  constructor(private readonly registry: ConnectorRegistryService) {}
  onModuleInit(): void {
    const adapter = createKlaviyoAdapter();
    this.registry.registerSource(adapter);
    this.registry.registerDestination(adapter);
  }
}
