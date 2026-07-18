import { Injectable } from '@nestjs/common';

/**
 * INTERFACE para os números reportados pela PLATAFORMA de anúncios (Meta/Google),
 * por conta de anúncio/dia. Fonte real: M10 — Criativos & Ads (onda futura).
 *
 * O monitor de discrepância (PRD §M14) compara o `delta` do M10 ao longo do
 * tempo: conversões que a plataforma reporta vs. conversões reconciliadas do
 * Truvo. Delta subitamente muito alto costuma indicar PROBLEMA DE TRACKING, não
 * superioridade — por isso alertamos em vez de comemorar.
 *
 * Enquanto o M10 não existe, injetamos {@link UnavailablePlatformMetricsProvider}
 * (retorna vazio). Na integração, o M10 fornece um provider real para o mesmo
 * token de DI e o monitor passa a ter os dois lados. Ver openTODOs.
 */
export interface PlatformDailyMetric {
  day: string; // YYYY-MM-DD (UTC)
  adAccount: string;
  channel: string; // ex.: 'facebook', 'google'
  platformConversions: number;
  platformRevenue: number;
  spend?: number;
}

export interface PlatformMetricsProvider {
  /**
   * Métricas por dia/canal reportadas pela plataforma. `adAccount` opcional
   * filtra por conta. Retorna [] quando indisponível.
   */
  getDailyMetrics(
    workspaceId: string,
    adAccount: string | undefined,
    startDay: string,
    endDay: string,
  ): Promise<PlatformDailyMetric[]>;

  /** A fonte de dados de plataforma está disponível? (false enquanto M10 não existe.) */
  isAvailable(): boolean;
}

/** Token de DI para o provider de métricas de plataforma. */
export const PLATFORM_METRICS_PROVIDER = Symbol('PLATFORM_METRICS_PROVIDER');

/**
 * Stub usado até o M10 existir. Não inventa número (regra 12/14): retorna vazio e
 * sinaliza indisponibilidade — o monitor então reporta só o lado Truvo e marca
 * `platform_available = false`.
 */
@Injectable()
export class UnavailablePlatformMetricsProvider implements PlatformMetricsProvider {
  // TODO(live): substituir pelo provider real do M10 (Criativos & Ads) no wiring
  // de integração — mesmo token PLATFORM_METRICS_PROVIDER, sem tocar neste módulo.
  async getDailyMetrics(): Promise<PlatformDailyMetric[]> {
    return [];
  }

  isAvailable(): boolean {
    return false;
  }
}
