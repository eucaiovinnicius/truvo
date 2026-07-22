import type { Request, Response, NextFunction } from 'express';

/**
 * Cabeçalhos de segurança aplicados a todas as respostas (substitui o helmet —
 * que não está instalado; ambiente offline). Valores conservadores para uma API
 * JSON servida atrás de CDN/proxy.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Impede sniffing de MIME (evita que respostas JSON sejam interpretadas como HTML/JS).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A API não deve ser embutida em <iframe> — mitiga clickjacking.
  res.setHeader('X-Frame-Options', 'DENY');
  // Não vaza a URL de origem em navegações/subrequests.
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Desliga o filtro XSS legado dos browsers (buggy); postura recomendada hoje (idem helmet).
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  // HSTS só faz sentido sobre TLS. Atrás de proxy/CDN confie em x-forwarded-proto
  // (exige `trust proxy` ligado no main.ts). 180 dias + subdomínios.
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
}
