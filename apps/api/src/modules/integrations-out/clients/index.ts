import type { Provider } from '@nestjs/common';
import type { IntegrationOutPlatform } from '@truvo/db';
import { CONVERSION_CLIENTS } from '../integrations-out.constants';
import { GoogleEnhancedClient } from './google-enhanced.client';
import { HubspotClient } from './hubspot.client';
import { MetaCapiClient } from './meta-capi.client';
import { TikTokEventsClient } from './tiktok-events.client';
import type { ConversionClient } from './types';

export type ConversionClientRegistry = Map<IntegrationOutPlatform, ConversionClient>;

/**
 * Registry (plataforma → client) montado por DI. Injetado no forwarder e no
 * controller via o token {@link CONVERSION_CLIENTS}. Novo provider = 1 linha aqui.
 */
export const conversionClientsProvider: Provider = {
  provide: CONVERSION_CLIENTS,
  useFactory: (
    meta: MetaCapiClient,
    google: GoogleEnhancedClient,
    tiktok: TikTokEventsClient,
    hubspot: HubspotClient,
  ): ConversionClientRegistry =>
    new Map<IntegrationOutPlatform, ConversionClient>([
      [meta.platform, meta],
      [google.platform, google],
      [tiktok.platform, tiktok],
      [hubspot.platform, hubspot],
    ]),
  inject: [MetaCapiClient, GoogleEnhancedClient, TikTokEventsClient, HubspotClient],
};

export { MetaCapiClient, GoogleEnhancedClient, TikTokEventsClient, HubspotClient };
export type { ConversionClient } from './types';
