import type { TruvoEvent } from '@truvo/event-schema';

/**
 * Filtragem de bots (PRD §M14). Marca `is_bot` — NÃO deleta (auditável).
 * Eventos de bot são inseridos no ClickHouse mas nunca contam para
 * KPIs/funis/attribution/billing (regra 11 — imposta nas MVs e no contador).
 *
 * Heurística inicial (determinística por user_agent). TODO(live): reputação de
 * IP, ausência de interação e velocidade impossível de navegação (M14 completo).
 */

/** Padrões conhecidos de user-agents não-humanos. */
const BOT_UA_PATTERN =
  /(bot|crawler|spider|crawl|slurp|mediapartners|facebookexternalhit|facebot|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|headlesschrome|phantomjs|puppeteer|playwright|python-requests|curl\/|wget\/|go-http-client|okhttp|axios\/|node-fetch|http_request|libwww|scrapy|masscan|zgrab|nmap|monitoring|pingdom|uptimerobot|gtmetrix|lighthouse|googlebot|applebot|yandexbot|duckduckbot|baiduspider)/i;

/** UA vazio/genérico suspeito em tráfego de browser. */
const EMPTY_OR_TRIVIAL_UA = /^$|^-$|^mozilla\/\d+\.\d+$/i;

export function detectBot(event: TruvoEvent): boolean {
  const ua = event.context?.user_agent ?? '';
  if (!ua) {
    // page_view/session_start sem UA vindos do pixel são suspeitos; eventos
    // server-side (webhook/api) legitimamente não têm UA → não marcar por isso só.
    return event.source === 'pixel';
  }
  if (BOT_UA_PATTERN.test(ua)) return true;
  if (EMPTY_OR_TRIVIAL_UA.test(ua.trim())) return true;
  return false;
}
