# syntax=docker/dockerfile:1
#
# Imagem de produção do CONSUMER (worker Kafka standalone). Monorepo pnpm + turbo.
# BUILD (a partir da RAIZ do repo, que é o contexto):
#   docker build -f apps/consumer/Dockerfile -t truvo-consumer .
#
# DOIS ENTRYPOINTS (o consumer tem duas filas independentes — ver src/identity/main.ts):
#   - Principal (M2 event pipeline): node dist/main.js           ← CMD padrão desta imagem
#   - Identity stitch worker (M8):   node dist/identity/main.js  ← suba um 2º container
#     com o CMD sobrescrito, ex.:
#       docker run truvo-consumer node dist/identity/main.js
# São processos SEPARADOS de propósito (escalam independente). A MESMA imagem serve os dois.

# ---------- base: pnpm sobre node 20 alpine ----------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@8.5.1 --activate
WORKDIR /repo

# ---------- builder: instala TUDO e builda o consumer + workspace deps ----------
FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile
# tsc (build do consumer) + tsup (db/event-schema) em ordem topológica.
RUN pnpm --filter "@truvo/consumer..." build

# ---------- deploy: bundle self-contained só com deps de produção ----------
FROM builder AS deploy
RUN pnpm --filter "@truvo/consumer" --prod deploy /prod/consumer

# ---------- runner: imagem enxuta de runtime ----------
FROM node:20-alpine AS runner
# tini = PID 1 → encaminha SIGTERM p/ o shutdown gracioso (consumer.stop() no SIGTERM).
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy --chown=node:node /prod/consumer ./
USER node
# Sem porta HTTP: worker de fila. Sem HEALTHCHECK HTTP (use liveness do orquestrador).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
