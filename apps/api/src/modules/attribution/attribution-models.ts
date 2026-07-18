import type { AttributionModel } from './attribution.constants';

/**
 * M7 — distribuição de CRÉDITO por touchpoint. Funções PURAS e determinísticas
 * (sem I/O), fáceis de testar. Dado um caminho de conversão (timestamps dos toques
 * ORDENADOS por ts asc) e o instante da conversão, cada modelo devolve um vetor de
 * pesos NÃO-negativos com a MESMA cardinalidade do caminho e que soma ~1.0.
 *
 * Modelos (PRD §7 M7):
 *  · last_click     → 100% no último toque.
 *  · first_click    → 100% no primeiro toque.
 *  · linear         → 1/N igualmente.
 *  · position_based → U-shaped 40/40/20 (40% 1º, 40% último, 20% dividido no meio).
 *  · time_decay     → peso ∝ e^(-λ·dias_antes_da_conversão); λ = ln(2)/meia-vida.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Vetor de pesos do modelo para um caminho de `tsList.length` toques.
 * `tsList` são timestamps (ms epoch) ORDENADOS asc; `convTs` é o instante da
 * conversão (ms epoch); `halfLifeDays` só é usado no time_decay.
 */
export function computeWeights(
  model: AttributionModel,
  tsList: number[],
  convTs: number,
  halfLifeDays: number,
): number[] {
  const n = tsList.length;
  if (n <= 0) return [];
  // Caminho de 1 toque: qualquer modelo credita 100% a ele.
  if (n === 1) return [1];

  switch (model) {
    case 'first_click':
      return unit(n, 0);

    case 'last_click':
      return unit(n, n - 1);

    case 'linear':
      return new Array<number>(n).fill(1 / n);

    case 'position_based': {
      // N==2 → 50/50 (não há "meio"); N>=3 → 40% pontas, 20% dividido no miolo.
      if (n === 2) return [0.5, 0.5];
      const w = new Array<number>(n).fill(0);
      const mid = 0.2 / (n - 2);
      for (let i = 1; i < n - 1; i++) w[i] = mid;
      w[0] = 0.4;
      w[n - 1] = 0.4;
      return w;
    }

    case 'time_decay': {
      const halfLife = halfLifeDays > 0 ? halfLifeDays : 1;
      const lambda = Math.LN2 / halfLife;
      const raw = tsList.map((ts) => {
        const days = Math.max(0, (convTs - ts) / MS_PER_DAY);
        return Math.exp(-lambda * days);
      });
      const total = raw.reduce((a, b) => a + b, 0);
      // Degenerado (todos os pesos ~0 por underflow): cai para last_click.
      if (!(total > 0) || !Number.isFinite(total)) return unit(n, n - 1);
      return raw.map((r) => r / total);
    }

    default:
      // Nunca alcançado (model vem de enum). Fallback conservador: last_click.
      return unit(n, n - 1);
  }
}

/** Vetor unitário: 1.0 no índice `hot`, 0 no resto. */
function unit(n: number, hot: number): number[] {
  const w = new Array<number>(n).fill(0);
  if (hot >= 0 && hot < n) w[hot] = 1;
  return w;
}
