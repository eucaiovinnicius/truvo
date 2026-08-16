import type { Response, NextFunction } from 'express';
import type { RequestWithId } from './http.types';
import { metrics, structuredLog } from '@truvo/observability';

/**
 * Log estruturado de acesso — uma linha por request, emitida no `finish` da
 * resposta (quando já temos status e duração). Usa o Logger do Nest (sem pino/morgan).
 * Campos: method, path, status, durationMs, requestId, ip. Nível pelo status:
 * 5xx=error, 4xx=warn, resto=log.
 *
 * SÓ o PATH é logado (sem query string): num produto de tracking, a query costuma
 * carregar PII/segredos (?email=, gclid/fbclid, magic-link ?token=) — não vão pro log.
 */
export function httpLoggerMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const payload = {
      requestId: req.requestId,
      method: req.method,
      path: (req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    };
    metrics.increment('http_requests_total', { status: res.statusCode, method: req.method });
    metrics.gauge('http_last_latency_ms', payload.durationMs);
    if (res.statusCode >= 400) metrics.increment('http_errors_total', { status: res.statusCode });
    structuredLog(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', payload);
  });

  next();
}
