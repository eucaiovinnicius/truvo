import { Logger } from '@nestjs/common';
import type { Response, NextFunction } from 'express';
import type { RequestWithId } from './http.types';

const logger = new Logger('HTTP');

/**
 * Log estruturado de acesso — uma linha por request, emitida no `finish` da
 * resposta (quando já temos status e duração). Usa o Logger do Nest (sem pino/morgan).
 * Campos: method, url, status, durationMs, requestId, ip. Nível pelo status:
 * 5xx=error, 4xx=warn, resto=log.
 */
export function httpLoggerMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const payload = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    };
    const line = JSON.stringify(payload);

    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.log(line);
  });

  next();
}
