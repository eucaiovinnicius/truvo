import { Injectable } from '@nestjs/common';

/**
 * INTERFACE do SPEND de anúncios por canal/campanha. Fonte real: M10 — Criativos
 * & Ads (onda futura). O M7 usa isto para ROAS (receita_atribuída / spend) e CAC
 * (spend / conversões) no campaign-breakdown.
 *
 * Enquanto o M10 não existe, injetamos {@link UnavailableAdSpendProvider} (retorna
 * vazio e sinaliza indisponibilidade). Na integração, o M10 fornece um provider
 * real para o MESMO token de DI (AD_SPEND_PROVIDER) sem tocar neste módulo — mesmo
 * padrão do M14 (PLATFORM_METRICS_PROVIDER). Ver openTODOs.
 *
 * Regra 12/14: não inventamos spend. Sem provider real → ROAS/CAC = null e
 * `spend_available = false`.
 */
export interface AdSpendRow {
  /** Canal normalizado (ex.: 'paid_social', 'paid_search'). */
  channel: string;
  /** Campanha (utm_campaign) — opcional; quando ausente, o spend é de canal. */
  utmCampaign?: string;
  /** Investimento na moeda do workspace. */
  spend: number;
  clicks?: number;
  impressions?: number;
}

export interface AdSpendProvider {
  /**
   * Spend por canal/campanha no intervalo [start, end). Retorna [] quando
   * indisponível (M10 ausente).
   */
  getSpend(workspaceId: string, start: Date, end: Date): Promise<AdSpendRow[]>;

  /** A fonte de spend está disponível? (false enquanto o M10 não existe.) */
  isAvailable(): boolean;
}

/** Token de DI para o provider de spend de anúncios. */
export const AD_SPEND_PROVIDER = Symbol('AD_SPEND_PROVIDER');

/**
 * Stub usado até o M10 existir. Não inventa número (regra 12): retorna vazio e
 * sinaliza indisponibilidade — o breakdown então mostra conversões/receita
 * atribuída, mas ROAS/CAC/spend ficam null e `spend_available = false`.
 */
@Injectable()
export class UnavailableAdSpendProvider implements AdSpendProvider {
  // TODO(live): substituir pelo provider real do M10 no wiring de integração —
  // mesmo token AD_SPEND_PROVIDER, sem tocar neste módulo.
  async getSpend(): Promise<AdSpendRow[]> {
    return [];
  }

  isAvailable(): boolean {
    return false;
  }
}
