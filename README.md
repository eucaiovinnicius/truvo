# Truvo

SaaS de funnel tracking, attribution e analytics. **Dados que você pode confiar.**

> Fonte de verdade do produto: [`PRD.md`](./PRD.md) (v3.2). Leia antes de implementar.

## Monorepo (Turborepo + pnpm)

```
apps/
  web/        # Next.js 14 (App Router) — dashboard
  api/        # NestJS — REST + webhooks + ingestão
  consumer/   # NestJS worker — Kafka → ClickHouse (skeleton; M2)
packages/
  event-schema/  # EventSchema (zod), compartilhado
  db/            # Drizzle (Postgres) + client ClickHouse
infra/
  docker-compose.yml   # ClickHouse + Redpanda + Redis (dev local)
_reference/     # protótipo Vite antigo (referência visual, não buildado)
```

## Rodar em dev

Pré-requisitos: Node 20+, pnpm 8+, Docker Desktop.

```bash
cp .env.example .env            # preencher chaves do Supabase
pnpm install
pnpm infra:up                   # sobe ClickHouse + Redpanda + Redis
pnpm dev                        # sobe api (:3333) + web (:3000) + packages em watch
```

Health check: `curl http://localhost:3333/health` · `.../health/ready`.

## Estado

**Fase 0 — Fundação** (monorepo + infra + esqueletos). Próximo: M1 (Auth & Workspaces).
Ver o roadmap por fases na seção 6 do PRD.
