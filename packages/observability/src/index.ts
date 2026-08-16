const SECRET = /authorization|api[-_]?key|token|secret|password|cookie|email|phone|raw|properties|context/i;

export type FailureClass = 'transient' | 'permanent';
export interface Failure { kind: FailureClass; reason: string; retryAfterMs?: number }

export function classifyFailure(input: unknown): Failure {
  const status = typeof input === 'object' && input ? Number((input as { status?: number }).status) : undefined;
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return { kind: 'transient', reason: `http_${status}`, retryAfterMs: 1000 };
  if (status !== undefined && status >= 400) return { kind: 'permanent', reason: `http_${status}` };
  const message = input instanceof Error ? input.message : String(input ?? 'unknown');
  return /timeout|econn|network|temporar|unavailable/i.test(message)
    ? { kind: 'transient', reason: 'transport', retryAfterMs: 1000 }
    : { kind: 'permanent', reason: 'unknown' };
}

export function redact(value: unknown, key = ''): unknown {
  if (SECRET.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
export const metrics = {
  increment(name: string, labels: Record<string, string | number> = {}) { const key = `${name}:${JSON.stringify(labels)}`; counters.set(key, (counters.get(key) ?? 0) + 1); },
  gauge(name: string, value: number) { gauges.set(name, value); },
  snapshot() { return { counters: Object.fromEntries(counters), gauges: Object.fromEntries(gauges) }; },
  reset() { counters.clear(); gauges.clear(); },
};

export function structuredLog(level: 'info' | 'warn' | 'error', event: string, context: Record<string, unknown> = {}): void {
  const line = JSON.stringify(redact({ ts: new Date().toISOString(), service: process.env.TRUVO_SERVICE ?? 'truvo', environment: process.env.NODE_ENV ?? 'development', level, event, ...context }));
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}

export interface AlertHook { emit(alert: { event: string; severity: 'warning' | 'critical'; context: Record<string, unknown> }): Promise<void> | void }
export function emitAlert(hook: AlertHook | undefined, event: string, severity: 'warning' | 'critical', context: Record<string, unknown>): void {
  structuredLog(severity === 'critical' ? 'error' : 'warn', 'alert_hook', { event, severity, ...context });
  void hook?.emit({ event, severity, context: redact(context) as Record<string, unknown> });
}
