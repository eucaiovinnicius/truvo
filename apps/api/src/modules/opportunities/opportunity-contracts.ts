import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const OPPORTUNITY_POLICY = Object.freeze({
  version: 'opportunity-v1',
  defaultPageSize: 50,
  maxPageSize: 200,
  materializationChunkSize: 1_000,
  refreshIntervalHours: 24,
  exportChunkSize: 1_000,
  activationChunkSize: 100,
  maxSelectedRows: 10_000,
  maxFilterCount: 12,
});

export const OPPORTUNITY_SORTS = ['expectedRevenue', 'probability', 'recentActivity'] as const;
export type OpportunitySort = (typeof OPPORTUNITY_SORTS)[number];
export type SortDirection = 'asc' | 'desc';

export interface OpportunityFilters {
  scoreBands?: Array<'high' | 'medium' | 'low'>;
  probabilityMin?: number;
  probabilityMax?: number;
  monetary?: boolean;
  currency?: string;
  expectedRevenueMin?: string;
  expectedRevenueMax?: string;
  recentActivityAfter?: string;
  trait?: { namespace: string; key: string; value: string };
}

export interface OpportunityQuery {
  sort?: OpportunitySort;
  direction?: SortDirection;
  filters?: OpportunityFilters;
}

export type OpportunitySelection =
  | { mode: 'selected'; batchId: string; ids: string[] }
  | { mode: 'all_matching'; batchId: string; query?: OpportunityQuery };

export interface OpportunityCursorPayload {
  v: 1;
  workspaceId: string;
  radarId: string;
  batchId: string;
  sort: OpportunitySort;
  direction: SortDirection;
  sortValue: string | null;
  secondaryValue: string | null;
  id: string;
  queryHash: string;
}

function cursorSecret(): string {
  const value = process.env.OPPORTUNITY_CURSOR_SECRET
    ?? process.env.SUPABASE_JWT_SECRET
    ?? (process.env.NODE_ENV === 'production' ? '' : 'truvo-opportunity-local-cursor-v1');
  if (!value) throw new Error('OPPORTUNITY_CURSOR_SECRET is required in production');
  return value;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function queryHash(query: OpportunityQuery): string {
  return createHash('sha256').update(stableStringify(query)).digest('base64url').slice(0, 22);
}

export function encodeCursor(payload: OpportunityCursorPayload): string {
  const body = Buffer.from(stableStringify(payload)).toString('base64url');
  const signature = createHmac('sha256', cursorSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function decodeCursor(cursor: string): OpportunityCursorPayload {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra) throw new Error('invalid_cursor');
  const expected = createHmac('sha256', cursorSecret()).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('invalid_cursor'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('invalid_cursor'); }
  const value = parsed as Partial<OpportunityCursorPayload>;
  if (value.v !== 1 || !value.workspaceId || !value.radarId || !value.batchId || !value.id
    || !OPPORTUNITY_SORTS.includes(value.sort as OpportunitySort)
    || !['asc', 'desc'].includes(value.direction ?? '') || !value.queryHash) {
    throw new Error('invalid_cursor');
  }
  return value as OpportunityCursorPayload;
}

export function normalizeQuery(input: OpportunityQuery = {}): Required<Pick<OpportunityQuery, 'sort' | 'direction'>> & { filters: OpportunityFilters } {
  const filters = input.filters ?? {};
  const scoreBands = filters.scoreBands ? [...new Set(filters.scoreBands)].sort() : undefined;
  const currency = filters.currency?.trim().toUpperCase();
  const normalized = {
    sort: input.sort ?? 'expectedRevenue',
    direction: input.direction ?? 'desc',
    filters: {
      ...filters,
      scoreBands,
      currency: currency || undefined,
      trait: filters.trait ? {
        namespace: filters.trait.namespace.trim(),
        key: filters.trait.key.trim(),
        value: filters.trait.value,
      } : undefined,
    },
  };
  if (!OPPORTUNITY_SORTS.includes(normalized.sort)) throw new Error('invalid_sort');
  if (!['asc', 'desc'].includes(normalized.direction)) throw new Error('invalid_sort_direction');
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('invalid_currency');
  if (scoreBands?.some((entry) => !['high', 'medium', 'low'].includes(entry))) throw new Error('invalid_score_band');
  for (const probability of [filters.probabilityMin, filters.probabilityMax]) {
    if (probability !== undefined && (!Number.isFinite(probability) || probability < 0 || probability > 1)) throw new Error('invalid_probability_filter');
  }
  if (filters.probabilityMin !== undefined && filters.probabilityMax !== undefined && filters.probabilityMin > filters.probabilityMax) throw new Error('invalid_probability_range');
  if (filters.trait && (!/^[a-zA-Z0-9_.-]{1,64}$/.test(filters.trait.namespace) || !/^[a-zA-Z0-9_.-]{1,64}$/.test(filters.trait.key))) throw new Error('invalid_trait_filter');
  if (Object.values(normalized.filters).filter((entry) => entry !== undefined).length > OPPORTUNITY_POLICY.maxFilterCount) throw new Error('filter_complexity_exceeded');
  return normalized;
}

/** CSV injection protection for strings, while preserving genuine typed numbers. */
export function csvCell(value: unknown, typedNumeric = false): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (!typedNumeric && /^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
