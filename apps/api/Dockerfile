# syntax=docker/dockerfile:1
#
# Imagem de produção da API (NestJS). Monorepo pnpm + turbo.
# BUILD (a partir da RAIZ do repo, que é o contexto):
#   docker build -f apps/api/Dockerfile -t truvo-api .
# O build da imagem TEM rede (o `pnpm install` roda aqui); só o dev local é offline.

# ---------- base: pnpm sobre node 20 alpine ----------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# corepack já vem no node 20; fixa a mesma versão do packageManager (package.json).
RUN corepack enable && corepack prepare pnpm@8.5.1 --activate
WORKDIR /repo

# ---------- builder: instala TUDO e builda a api + seus workspace deps ----------
FROM base AS builder
# Copia o repo inteiro. O .dockerignore exclui node_modules/dist/.next/.env/.git,
# então o lockfile + os package.json + o código-fonte é o que entra.
COPY . .
# --frozen-lockfile garante reprodutibilidade (falha se o lockfile divergir).
RUN pnpm install --frozen-lockfile
# Builda @truvo/api E suas deps de workspace em ordem topológica
# (o sufixo "..." inclui dependências): @truvo/db (tsup), event-schema, pixel, e depois nest build.
RUN pnpm --filter "@truvo/api..." build

# ---------- deploy: bundle self-contained só com deps de produção ----------
FROM builder AS deploy
# `pnpm deploy --prod` monta em /prod/api um node_modules real (sem symlinks de
# workspace), com as workspace deps já buildadas embutidas e sem devDependencies.
RUN pnpm --filter "@truvo/api" --prod deploy /prod/api

# ---------- runner: imagem enxuta de runtime ----------
FROM node:20-alpine AS runner
# tini = PID 1 correto → encaminha SIGTERM p/ shutdown gracioso do Nest.
RUN apk add --no-cache tini
ENV NODE_ENV=production
ENV API_PORT=3333
WORKDIR /app
# Copia só o bundle de produção; roda como usuário não-root (`node` já existe na imagem).
COPY --from=deploy --chown=node:node /prod/api ./
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3333/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
