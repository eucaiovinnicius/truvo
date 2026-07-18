import type { TruvoEvent } from '@truvo/event-schema';

/**
 * M14 — Detecção de bots (LÓGICA PURA, sem framework).
 *
 * Marca `is_bot` — NUNCA deleta (auditável, regra 11). Eventos de bot entram no
 * ClickHouse mas nunca contam para KPIs/funis/attribution/billing.
 *
 * Sinais suportados (PRD §M14 "Filtragem de bots"):
 *   1. user_agent contra listas conhecidas de tráfego não-humano;
 *   2. UA ausente/trivial em tráfego que deveria ser de browser;
 *   3. IP em faixa de datacenter (via CIDRs configurados);
 *   4. velocidade impossível de navegação (eventos/seg por sessão);
 *   5. ausência de interação (muitos pageviews, zero clique/scroll/form);
 *   6. rajada de requisições (rate anômalo por identidade).
 *
 * Os sinais 4–6 dependem de ESTADO de sessão que só o consumer tem (Redis) — são
 * opcionais (`BotSignals`). Quando ausentes, a detecção cai para os sinais 1–3,
 * puramente por evento (o que o consumer do M2 já usa hoje).
 *
 * COORDENAÇÃO COM O CONSUMER (M2): hoje `apps/consumer/src/bot-filter.ts` tem um
 * `detectBot` mais simples (só UA). Este módulo é a versão completa do M14. Como
 * api e consumer são apps separados sem pacote compartilhado, a duplicação é
 * intencional por ora — ver openTODOs: mover esta lógica para @truvo/event-schema
 * e fazer o consumer importá-la (fonte única).
 */

/** Motivos possíveis de classificação como bot. */
export type BotReason =
  | 'ua_blocklist'
  | 'ua_empty_or_trivial'
  | 'ua_missing_on_client'
  | 'datacenter_ip'
  | 'impossible_velocity'
  | 'no_interaction'
  | 'request_burst';

/** Sinais de sessão (opcionais) que só a ingestão consegue calcular. */
export interface BotSignals {
  /** Nº de eventos observados na sessão até agora. */
  eventsInSession?: number;
  /** Duração da sessão em ms (max_ts - min_ts). */
  sessionDurationMs?: number;
  /** Nº de eventos de interação na sessão (click/scroll/form_submit/...). */
  interactionEvents?: number;
  /** Requisições da mesma identidade no último minuto (rate). */
  requestsLastMinute?: number;
}

export interface BotVerdict {
  isBot: boolean;
  reasons: BotReason[];
}

export interface BotDetectorConfig {
  /** Regex extra de UA (além da lista embutida). */
  extraUaPattern?: RegExp;
  /** Faixas IPv4 de datacenter (CIDR, ex.: "34.64.0.0/10"). */
  datacenterCidrs?: string[];
  /** Teto humano de eventos/segundo numa sessão (acima → impossível). */
  maxEventsPerSecond?: number;
  /** Piso de eventos/sessão para o gate de velocidade valer. */
  minEventsForVelocity?: number;
  /** Sessão com muitos pageviews e zero interação abaixo desta duração → suspeita. */
  noInteractionMinEvents?: number;
  noInteractionMaxDurationMs?: number;
  /** Teto de requisições/min por identidade (acima → rajada). */
  maxRequestsPerMinute?: number;
}

/** Fontes que DEVERIAM carregar UA de browser (client-side). */
const CLIENT_SOURCES = new Set(['pixel', 'url', 'redirect']);

/** Padrões conhecidos de user-agents não-humanos. */
const BOT_UA_PATTERN =
  /(bot|crawler|spider|crawl|slurp|mediapartners|facebookexternalhit|facebot|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|headlesschrome|phantomjs|puppeteer|playwright|selenium|python-requests|curl\/|wget\/|go-http-client|okhttp|axios\/|node-fetch|http_request|libwww|scrapy|masscan|zgrab|nmap|monitoring|pingdom|uptimerobot|gtmetrix|lighthouse|googlebot|applebot|yandexbot|duckduckbot|baiduspider|bytespider|gptbot|claudebot|ccbot|amazonbot)/i;

/** UA vazio/genérico suspeito em tráfego de browser. */
const EMPTY_OR_TRIVIAL_UA = /^$|^-$|^mozilla\/\d+\.\d+$/i;

const DEFAULTS: Required<Omit<BotDetectorConfig, 'extraUaPattern' | 'datacenterCidrs'>> = {
  maxEventsPerSecond: 8,
  minEventsForVelocity: 6,
  noInteractionMinEvents: 12,
  noInteractionMaxDurationMs: 4000,
  maxRequestsPerMinute: 600,
};

/* ───────────────────────────── CIDR (IPv4) ───────────────────────────── */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    acc = acc * 256 + octet;
  }
  return acc >>> 0;
}

/** `ip` está dentro do bloco `cidr` (IPv4)? Entrada malformada → false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.split('/');
  const range = slash[0];
  if (!range) return false;
  const bits = slash[1] === undefined ? 32 : Number(slash[1]);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/* ─────────────────────────────── detecção ─────────────────────────────── */

/**
 * Classifica um evento como bot. Determinístico. `signals` opcionais habilitam os
 * gates de velocidade/interação/rajada; sem eles, decide por UA + IP.
 */
export function detectBot(
  event: TruvoEvent,
  signals?: BotSignals,
  config: BotDetectorConfig = {},
): BotVerdict {
  const reasons: BotReason[] = [];
  // Coalesce por campo (não spread): um `config.x === undefined` vindo do env NÃO
  // pode sobrescrever o default numérico.
  const cfg = {
    maxEventsPerSecond: config.maxEventsPerSecond ?? DEFAULTS.maxEventsPerSecond,
    minEventsForVelocity: config.minEventsForVelocity ?? DEFAULTS.minEventsForVelocity,
    noInteractionMinEvents: config.noInteractionMinEvents ?? DEFAULTS.noInteractionMinEvents,
    noInteractionMaxDurationMs:
      config.noInteractionMaxDurationMs ?? DEFAULTS.noInteractionMaxDurationMs,
    maxRequestsPerMinute: config.maxRequestsPerMinute ?? DEFAULTS.maxRequestsPerMinute,
  };

  const ua = (event.context?.user_agent ?? '').trim();
  const isClientSource = CLIENT_SOURCES.has(event.source);

  // 1–2. user_agent
  if (!ua) {
    // Eventos client-side sem UA são suspeitos; server-side (webhook/api)
    // legitimamente não têm UA → não marcar só por isso.
    if (isClientSource) reasons.push('ua_missing_on_client');
  } else if (BOT_UA_PATTERN.test(ua) || config.extraUaPattern?.test(ua)) {
    reasons.push('ua_blocklist');
  } else if (EMPTY_OR_TRIVIAL_UA.test(ua)) {
    reasons.push('ua_empty_or_trivial');
  }

  // 3. IP de datacenter (só disponível ANTES do enrich, que descarta o IP — regra 5).
  const ip = typeof event.context?.ip === 'string' ? event.context.ip.trim() : '';
  const cidrs = config.datacenterCidrs;
  if (ip && cidrs && cidrs.length > 0) {
    for (const cidr of cidrs) {
      if (ipInCidr(ip, cidr)) {
        reasons.push('datacenter_ip');
        break;
      }
    }
  }

  // 4. velocidade impossível de navegação.
  if (
    signals?.eventsInSession !== undefined &&
    signals.sessionDurationMs !== undefined &&
    signals.eventsInSession >= cfg.minEventsForVelocity &&
    signals.sessionDurationMs > 0
  ) {
    const eventsPerSecond = signals.eventsInSession / (signals.sessionDurationMs / 1000);
    if (eventsPerSecond > cfg.maxEventsPerSecond) reasons.push('impossible_velocity');
  }

  // 5. ausência de interação (muitos pageviews, zero clique/scroll/form, sessão curta).
  if (
    signals?.eventsInSession !== undefined &&
    signals.eventsInSession >= cfg.noInteractionMinEvents &&
    (signals.interactionEvents ?? 0) === 0 &&
    signals.sessionDurationMs !== undefined &&
    signals.sessionDurationMs <= cfg.noInteractionMaxDurationMs
  ) {
    reasons.push('no_interaction');
  }

  // 6. rajada de requisições.
  if (
    signals?.requestsLastMinute !== undefined &&
    signals.requestsLastMinute > cfg.maxRequestsPerMinute
  ) {
    reasons.push('request_burst');
  }

  return { isBot: reasons.length > 0, reasons };
}

/** Parse defensivo de uma lista de CIDRs vinda de env (CSV). */
export function parseCidrList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
