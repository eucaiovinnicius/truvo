import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorRegistryService } from '../../connector-registry.service';
import { createStripeAdapter } from './stripe.adapter';

@Injectable()
export class StripeBootstrapService implements OnModuleInit {
  constructor(private readonly registry: ConnectorRegistryService) {}
  onModuleInit(): void { this.registry.registerSource(createStripeAdapter()); }
}
