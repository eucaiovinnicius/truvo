import { Injectable } from '@nestjs/common';
import type { ConnectorDefinition, DestinationAdapter, SourceAdapter } from './contracts';

/**
 * In-process registry of adapters, keyed by `ConnectorDefinition.provider`. Mirrors
 * `webhooks/normalizers/index.ts`'s provider→function dispatch, generalized: a
 * future connector (Orders 60–63) calls `register()` once at module init and the
 * rest of the framework (orchestrator, webhook handler, destination service) never
 * needs a per-provider branch.
 */
@Injectable()
export class ConnectorRegistryService {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private readonly destinationAdapters = new Map<string, DestinationAdapter>();
  private readonly definitions = new Map<string, ConnectorDefinition>();

  registerSource(adapter: SourceAdapter): void {
    this.definitions.set(adapter.definition.provider, adapter.definition);
    this.sourceAdapters.set(adapter.definition.provider, adapter);
  }

  registerDestination(adapter: DestinationAdapter): void {
    this.definitions.set(adapter.definition.provider, adapter.definition);
    this.destinationAdapters.set(adapter.definition.provider, adapter);
  }

  getDefinition(provider: string): ConnectorDefinition | undefined {
    return this.definitions.get(provider);
  }

  getSourceAdapter(provider: string): SourceAdapter | undefined {
    return this.sourceAdapters.get(provider);
  }

  getDestinationAdapter(provider: string): DestinationAdapter | undefined {
    return this.destinationAdapters.get(provider);
  }

  listDefinitions(): ConnectorDefinition[] {
    return [...this.definitions.values()];
  }
}
