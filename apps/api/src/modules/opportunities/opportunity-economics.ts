export const VALUE_POLICY = Object.freeze({
  version: 'historical-value-v1',
  lookbackDays: 365,
  customerMinimumSamples: 3,
  cohortMinimumSamples: 30,
  trimFraction: 0.1,
  minimumTrimmedSampleSize: 5,
});

export type ValueQuality = 'high' | 'medium' | 'low' | 'unavailable';
export type ValueEstimate = {
  value: string;
  currency: string;
  source: 'customer' | 'cohort';
  sampleCount: number;
  quality: Exclude<ValueQuality, 'unavailable'>;
  policyVersion: string;
  lookbackDays: number;
  estimatedAt: string;
} | {
  value: null;
  currency: null;
  source: 'unavailable';
  sampleCount: number;
  quality: 'unavailable';
  policyVersion: string;
  lookbackDays: number;
  estimatedAt: string;
  reason: 'insufficient_monetary_history' | 'mixed_currency';
};

function decimalParts(input: string | number): { coefficient: bigint; scale: number } {
  const text = String(input).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new RangeError('invalid_decimal');
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${negative ? '-' : ''}${whole}${fraction}`);
  return { coefficient, scale: fraction.length };
}

function decimalString(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const raw = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  const normalized = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
  return `${negative ? '-' : ''}${normalized}`;
}

/** Exact base-10 multiplication; no IEEE-754 money arithmetic. */
export function multiplyDecimal(left: string | number, right: string | number): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return decimalString(a.coefficient * b.coefficient, a.scale + b.scale);
}

/**
 * Deterministic bounded trimmed mean. For five or more observations, at least one
 * value is removed from each tail; for larger samples floor(n*10%) is removed.
 * Missing, zero, negative, non-finite, refund/reversal values never become a
 * positive purchase estimate and are never transformed with abs().
 */
export function estimateValue(
  values: Array<{ value: number; currency: string; isRefundOrReversal?: boolean }>,
  source: 'customer' | 'cohort',
  estimatedAt = new Date().toISOString(),
): ValueEstimate {
  const valid = values.filter((entry) =>
    Number.isFinite(entry.value)
    && entry.value > 0
    && !entry.isRefundOrReversal
    && /^[A-Z]{3}$/.test(entry.currency.trim().toUpperCase()),
  );
  const currencies = [...new Set(valid.map((entry) => entry.currency.trim().toUpperCase()))];
  const minimum = source === 'customer' ? VALUE_POLICY.customerMinimumSamples : VALUE_POLICY.cohortMinimumSamples;
  const common = {
    sampleCount: valid.length,
    policyVersion: VALUE_POLICY.version,
    lookbackDays: VALUE_POLICY.lookbackDays,
    estimatedAt,
  };
  if (currencies.length > 1) {
    return { value: null, currency: null, source: 'unavailable', quality: 'unavailable', reason: 'mixed_currency', ...common };
  }
  if (!currencies.length || valid.length < minimum) {
    return { value: null, currency: null, source: 'unavailable', quality: 'unavailable', reason: 'insufficient_monetary_history', ...common };
  }

  const sorted = valid.map((entry) => entry.value).sort((a, b) => a - b);
  const trim = sorted.length >= VALUE_POLICY.minimumTrimmedSampleSize
    ? Math.max(1, Math.floor(sorted.length * VALUE_POLICY.trimFraction))
    : 0;
  const selected = sorted.slice(trim, sorted.length - trim);
  const value = selected.reduce((sum, current) => sum + current, 0) / selected.length;
  const quality: Exclude<ValueQuality, 'unavailable'> = source === 'customer'
    ? (valid.length >= 5 ? 'high' : 'medium')
    : (valid.length >= 100 ? 'medium' : 'low');
  return { value: String(value), currency: currencies[0]!, source, quality, ...common };
}

export function expectedRevenue(probability: string | number, estimate: ValueEstimate): string | null {
  const numericProbability = Number(probability);
  if (!Number.isFinite(numericProbability) || numericProbability < 0 || numericProbability > 1) {
    throw new RangeError('invalid_probability');
  }
  return estimate.value === null ? null : multiplyDecimal(probability, estimate.value);
}
