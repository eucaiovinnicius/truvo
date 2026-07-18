import { UAParser } from 'ua-parser-js';
import type { TruvoEvent, DeviceType } from '@truvo/event-schema';

/**
 * Enriquecimento de evento (PRD §7 M2):
 *   user_agent → device_type + os + browser  (ua-parser-js)
 *   ip         → ip_country + ip_city         (TODO(live) MaxMind GeoIP)
 *
 * ⚠️ regra 5: o `ip` bruto NUNCA é persistido. Aqui derivamos país/cidade e o IP
 * é descartado (nunca entra na linha do ClickHouse — ver clickhouse-batch.ts).
 */

function mapDeviceType(uaDeviceType: string | undefined): DeviceType | '' {
  switch (uaDeviceType) {
    case 'mobile':
      return 'mobile';
    case 'tablet':
      return 'tablet';
    case 'console':
    case 'smarttv':
    case 'wearable':
    case 'embedded':
      return 'mobile';
    default:
      // ua-parser-js retorna undefined p/ desktop
      return 'desktop';
  }
}

export interface EnrichedContext {
  device_type: string;
  os: string;
  browser: string;
  ip_country: string;
  ip_city: string;
}

export function enrich(event: TruvoEvent): EnrichedContext {
  const ctx = event.context ?? {};
  const ua = ctx.user_agent ?? '';

  let deviceType = ctx.device_type ?? '';
  let os = ctx.os ?? '';
  let browser = ctx.browser ?? '';

  if (ua) {
    const parsed = new UAParser(ua).getResult();
    if (!deviceType) deviceType = mapDeviceType(parsed.device.type);
    if (!os) os = parsed.os.name ?? '';
    if (!browser) browser = parsed.browser.name ?? '';
  }

  // Geo: preferir o que já veio (webhooks às vezes trazem country); senão TODO MaxMind.
  let ipCountry = ctx.ip_country ?? '';
  let ipCity = ctx.ip_city ?? '';
  if (!ipCountry && ctx.ip) {
    // TODO(live): lookup MaxMind GeoIP (city+country) a partir de ctx.ip.
    // ctx.ip é descartado logo após este ponto (regra 5) — nunca persistido.
    ipCountry = '';
    ipCity = '';
  }

  return {
    device_type: deviceType,
    os,
    browser,
    ip_country: ipCountry,
    ip_city: ipCity,
  };
}
