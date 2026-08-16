# Truvo

**AI Revenue Intelligence. Know who will buy next.**

Este repositório contém a base Truvo v3.2 em evolução incremental para Truvo 4.x.

> Fonte de verdade atual: [`docs/truvo/TRUVO_PRD_v4.4.md`](./docs/truvo/TRUVO_PRD_v4.4.md). Trabalho autorizado: [`docs/exec/ACTIVE_WORK_ITEM.md`](./docs/exec/ACTIVE_WORK_ITEM.md).

## Monorepo (Turborepo + pnpm)

```
apps/
  web/        # Next.js 14 (App Router) — dashboard
  api/        # NestJS — REST + webhooks + ingestão
  consumer/   # NestJS workers — pipeline Kafka → ClickHouse e identity stitching
packages/
  event-schema/  # EventSchema (zod), compartilhado
  db/            # Drizzle (Postgres) + client ClickHouse
infra/
  docker-compose.yml   # ClickHouse + Redpanda + Redis (dev local)
_reference/     # protótipo Vite antigo (referência visual, não buildado)
```

## Rodar em dev

Pré-requisitos: Node 20.11+, pnpm 8.5.1 e Docker Desktop.

```bash
cp .env.example .env            # preencher chaves do Supabase
pnpm install --frozen-lockfile
pnpm infra:up                   # sobe ClickHouse + Redpanda + Redis
pnpm dev                        # sobe api (:3333) + web (:3000) + packages em watch
```

Health check: `curl http://localhost:3333/health` · `.../health/ready`.

## Estado

A implementação v3.2 existente inclui auth/workspaces, ingestão e consumo de eventos, identidade, atribuição, data quality, billing, integrações e o app web. A migração 4.x deve seguir um Execution Order por vez; consulte o work item ativo acima.
