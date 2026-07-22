# syntax=docker/dockerfile:1
#
# Imagem de produção do WEB (Next.js 14). Monorepo pnpm + turbo.
# BUILD (a partir da RAIZ do repo, que é o contexto):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.seu-dominio.com -t truvo-web .
#
# NOTA: NEXT_PUBLIC_* é inlinado no bundle EM BUILD. Passe a URL real da API via
# --build-arg (o default abaixo serve só para builds locais). `next start` na porta 3000.
# (Imagem funcional/simples: usa `next start`. Para uma imagem mínima seria possível
#  ativar `output: 'standalone'` no next.config — deixado fora para não alterar o app.)

# ---------- base: pnpm sobre node 20 alpine ----------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@8.5.1 --activate
WORKDIR /repo

# ---------- builder: instala TUDO e builda o web + workspace deps ----------
FROM base AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:3333
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY . .
RUN pnpm install --frozen-lockfile
# next build (web) + tsup (@truvo/event-schema, transpilePackages) em ordem topológica.
RUN pnpm --filter "@truvo/web..." build

# ---------- deploy: bundle self-contained só com deps de produção ----------
FROM builder AS deploy
# --prod mantém `next`/react (dependencies) e o .next já buildado; remove tailwind/postcss (dev).
RUN pnpm --filter "@truvo/web" --prod deploy /prod/web

# ---------- runner: imagem enxuta de runtime ----------
FROM node:20-alpine AS runner
RUN apk add --no-cache tini
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
WORKDIR /app
COPY --from=deploy --chown=node:node /prod/web ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# `next start` serve o .next buildado na porta 3000.
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
