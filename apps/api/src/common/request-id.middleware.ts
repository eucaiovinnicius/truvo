import { randomUUID } from 'node:crypto';
import type { Response, NextFunction } from 'express';
import { REQUEST_ID_HEADER, type RequestWithId } from './http.types';

/**
 * Correlação de requests (observabilidade — sem libs externas).
 *
 * Lê `x-request-id` do header (propagado por CDN/gateway) ou gera um UUID novo
 * com `crypto.randomUUID()` (Node stdlib). Anexa em `req.requestId` para o logger
 * e reflete no header da resposta para o cliente correlacionar.
 */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const fromHeader = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim();
  const requestId = fromHeader && fromHeader.length > 0 ? fromHeader : randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
