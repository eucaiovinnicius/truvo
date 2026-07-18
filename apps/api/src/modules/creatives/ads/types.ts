/**
 * M10 — contratos dos clientes de Ads API (Meta/Google/TikTok).
 *
 * Cada cliente lê credenciais do ENV (fail-closed: sem token → isConfigured()=false
 * → retorna []), faz a chamada real via fetch nativo (Node 20) e NORMALIZA para as
 * duas formas abaixo:
 *   · CreativeDailyRow → uma linha de `creative_daily` (métrica reportada/dia).
 *   · CreativeMeta     → metadados p/ o cache Postgres `creatives` (thumbnail etc.).
 *
 * // TODO(live): as chamadas dependem de aprovação/ToS de cada plataforma (PRD §16,
 * risco R3/R4). O código está pronto para produção lendo o token do ENV.
 */
import type { CreativePlatform, CreativePhase, CreativeType } from '@truvo/db';

/** Uma linha diária de métrica reportada, pronta p/ inserir em `creative_daily`. */
export interface CreativeDailyRow {
  workspace_id: string;
  platform: CreativePlatform;
  ad_id: string;
  day: string; // YYYY-MM-DD
  ad_account_id: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  ad_name: string;
  creative_type: string;
  phase: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  platform_conversions: number;
  platform_revenue: number;
}

/** Metadados do criativo p/ o cache Postgres `creatives`. */
export interface CreativeMeta {
  platform: CreativePlatform;
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adsetName: string;
  creativeType: CreativeType;
  phase: CreativePhase;
  thumbnailUrl: string;
  previewUrl: string;
  adStatus: string;
  landingUrl: string;
  raw: Record<string, unknown>;
}

/** Contrato comum aos três clientes de plataforma. */
export interface AdsPlatformClient {
  readonly platform: CreativePlatform;
  /** Token/credenciais presentes no ENV? (fail-closed quando false.) */
  isConfigured(): boolean;
  /** Métricas diárias reportadas por criativo no intervalo [startDay, endDay]. */
  fetchDailyInsights(
    workspaceId: string,
    accountId: string,
    startDay: string,
    endDay: string,
  ): Promise<CreativeDailyRow[]>;
  /** Metadados dos criativos da conta (thumbnail, tipo, campanha, status). */
  fetchCreatives(accountId: string): Promise<CreativeMeta[]>;
}

/** Deriva a fase (TOF/MOF/BOF) a partir do nome da campanha/adset (heurística). */
export function inferPhase(...names: string[]): CreativePhase {
  const hay = names.join(' ').toLowerCase();
  if (/\b(bof|bottom|retarget|remarket|conversion|conversao|conversão|purchase|checkout)\b/.test(hay)) {
    return 'BOF';
  }
  if (/\b(mof|middle|consideration|consideracao|consideração|engag|traffic|trafego|tráfego)\b/.test(hay)) {
    return 'MOF';
  }
  if (/\b(tof|top|awareness|prospect|cold|reach|alcance)\b/.test(hay)) {
    return 'TOF';
  }
  return 'unknown';
}

/** Normaliza o tipo do criativo a partir de um rótulo cru da plataforma. */
export function normalizeCreativeType(raw: string | undefined): CreativeType {
  const v = (raw ?? '').toLowerCase();
  if (/(video|reel|vídeo)/.test(v)) return 'video';
  if (/(carousel|carrossel|collection|slideshow)/.test(v)) return 'carousel';
  if (/(image|photo|single|imagem|static)/.test(v)) return 'image';
  return 'unknown';
}

/**
 * fetch com timeout (AbortController). Retorna a Response; o chamador decide o
 * parse. Lança em timeout/erro de rede — o chamador captura e degrada p/ [].
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
