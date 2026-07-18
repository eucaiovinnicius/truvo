import { Controller, Get, Param, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { TrackingService } from './tracking.service';
import type { TrackingLink } from '@truvo/db';

const CLICK_COOKIE = '_tvo_click';
const CLICK_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

/**
 * Rotas públicas do M3 (sem auth):
 *  - GET /c/:code  → redirect < 100ms, preserva params, gera click_id, incrementa contador
 *  - GET /pixel.js → serve o bundle do pixel (dev); em prod é CDN (ver notes)
 *
 * main.ts usa setGlobalPrefix('') → estas rotas ficam na raiz.
 */
@Controller()
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);
  constructor(private readonly tracking: TrackingService) {}

  @Get('c/:code')
  async redirect(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const link = await this.tracking.resolveByCode(code);
    if (!link) {
      res.status(404).type('text/plain').send('link not found');
      return;
    }

    const clickId = await this.tracking.newClickId(link.code);

    // Fire-and-forget: nada disto bloqueia o redirect (orçamento < 100ms).
    // O contador do Postgres é autoritativo; o log no ClickHouse é best-effort.
    void this.tracking.incrementClicks(link.id).catch((e) => this.logger.debug(`incr: ${e.message}`));
    void this.tracking.logClick({
      clickId,
      link,
      referrer: req.get('referer') ?? undefined,
      userAgent: req.get('user-agent') ?? undefined,
    });

    const destination = buildDestination(link, req.query, clickId);

    // Cookie first-party, SameSite=Lax (regra de privacidade / seção 11).
    res.cookie(CLICK_COOKIE, clickId, {
      maxAge: CLICK_COOKIE_MAX_AGE_MS,
      sameSite: 'lax',
      path: '/',
      httpOnly: false, // o pixel precisa poder ler em same-domain
    });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, destination);
  }

  @Get('pixel.js')
  async pixel(@Res() res: Response): Promise<void> {
    const path = resolvePixelPath();
    if (path) {
      try {
        const buf = await readFile(path);
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.send(buf);
        return;
      } catch {
        /* cai no 404 abaixo */
      }
    }
    // TODO(live): em prod o pixel é servido por CDN (Vercel). Aqui é conveniência de dev.
    res
      .status(404)
      .type('application/javascript')
      .send('// truvo pixel indisponível — build @truvo/pixel ou defina PIXEL_JS_PATH');
  }
}

/** Preserva os params recebidos; UTMs configuradas do link vencem; anexa o click_id. */
export function buildDestination(
  link: TrackingLink,
  query: Request['query'],
  clickId: string,
): string {
  const url = new URL(link.destinationUrl);

  for (const [key, raw] of Object.entries(query)) {
    const val = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (typeof val === 'string') url.searchParams.set(key, val);
  }

  const utms: Array<[string, string | null]> = [
    ['utm_source', link.utmSource],
    ['utm_medium', link.utmMedium],
    ['utm_campaign', link.utmCampaign],
    ['utm_content', link.utmContent],
    ['utm_term', link.utmTerm],
  ];
  for (const [k, v] of utms) if (v) url.searchParams.set(k, v);

  url.searchParams.set('truvo_click_id', clickId);
  return url.toString();
}

/** Resolve o caminho do bundle do pixel (workspace) ou usa PIXEL_JS_PATH. */
function resolvePixelPath(): string | null {
  if (process.env.PIXEL_JS_PATH) return process.env.PIXEL_JS_PATH;
  try {
    // require.resolve existe no bundle CommonJS do Nest.
    // Requer @truvo/pixel nas deps do apps/api (ver npmDeps).
    return require.resolve('@truvo/pixel/pixel.js');
  } catch {
    return null;
  }
}
