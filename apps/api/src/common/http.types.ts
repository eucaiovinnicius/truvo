import type { Request } from 'express';

/** Header canônico de correlação de requests (in/out). */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Request do Express com o id de correlação anexado pelo `requestIdMiddleware`.
 * Usado pelo logger de HTTP e disponível para handlers que queiram propagar o id.
 */
export interface RequestWithId extends Request {
  requestId?: string;
}
