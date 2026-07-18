/**
 * Limite inferior do intervalo de confiança de Wilson para uma proporção.
 *
 * Usado na CVR por canal (converters / persons): um canal com 1 conversão em 2
 * pessoas tem CVR pontual de 50%, mas o Wilson lower-bound o coloca em ~9% — evita
 * que o LLM/ranking superestime canais de baixa amostra (determinístico, regra 13).
 *
 * z = 1.96 → 95% de confiança (unilateral 97.5%).
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const s = Math.max(0, Math.min(successes, n));
  const phat = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lb = (centre - margin) / denom;
  return lb < 0 ? 0 : lb > 1 ? 1 : lb;
}
