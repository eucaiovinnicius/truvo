import 'reflect-metadata';
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validateEnv } from './common/env.validation';
import { requestIdMiddleware } from './common/request-id.middleware';
import { securityHeadersMiddleware } from './common/security-headers.middleware';
import { httpLoggerMiddleware } from './common/http-logger.middleware';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Fail-fast: valida env essencial ANTES de tocar em qualquer dependência.
  validateEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Atrás de CDN/proxy (Railway/Cloudflare): confia no 1º hop para IP real
  // (x-forwarded-for) e protocolo (x-forwarded-proto). Usado por rate-limit,
  // bot-filter, HSTS e pelo log de acesso.
  app.set('trust proxy', 1);

  // Observabilidade + segurança (middlewares manuais, sem libs externas).
  // Ordem: request-id primeiro (o logger o consome) → security headers → log de acesso.
  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(httpLoggerMiddleware);

  // CORS com allowlist via env CORS_ORIGINS (csv). Vazio = permissivo (dev) com aviso.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    logger.warn(
      'CORS_ORIGINS vazio — CORS permissivo (reflete qualquer Origin). Defina a allowlist em produção.',
    );
    app.enableCors({ origin: true, credentials: true });
  } else {
    app.enableCors({
      origin: (origin, callback) => {
        // Sem Origin (curl/health/server-to-server) é permitido; senão valida na allowlist.
        if (!origin || corsOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origin não permitida por CORS: ${origin}`), false);
        }
      },
      credentials: true,
    });
    logger.log(`CORS allowlist ativa (${corsOrigins.length} origin(s)).`);
  }

  app.setGlobalPrefix('', { exclude: ['health', 'health/ready'] });

  const port = Number(process.env.API_PORT ?? 3333);
  await app.listen(port);
  logger.log(`[truvo/api] escutando em http://localhost:${port}`);
}

void bootstrap();
