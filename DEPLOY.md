# Deploy do Truvo — Vercel + Supabase + Railway

Guia passo-a-passo para subir a stack em produção. **Ordem importa** (infra → migrações → serviços → front).

## Arquitetura

| Componente | Host | Artefato |
|---|---|---|
| `apps/web` (Next.js) | **Vercel** | `apps/web/vercel.json` |
| `apps/api` (NestJS) | **Railway** (serviço) | `apps/api/Dockerfile` + `apps/api/railway.json` |
| `apps/consumer` — pipeline M2 | **Railway** (serviço) | `apps/consumer/Dockerfile` + `apps/consumer/railway.json` |
| `apps/consumer` — stitch M8 | **Railway** (serviço) | mesma imagem + `apps/consumer/railway.identity.json` |
| Postgres + Auth | **Supabase** | (managed) |
| ClickHouse | **Railway** (ou ClickHouse Cloud) | template/imagem |
| Redpanda/Kafka | **Railway** (ou Redpanda Cloud/Upstash) | template/imagem |
| Redis | **Railway** (ou Upstash) | template/imagem |

> ⚠️ **Supabase é só Postgres+Auth** — ClickHouse, Kafka e Redis vão no Railway.
> ⚠️ Os Dockerfiles usam a **RAIZ do repo como contexto** (fazem `COPY . .`). No Railway, deixe o *root directory* do serviço como a raiz e aponte só o `dockerfilePath` (já configurado nos `railway.json`).

---

## Pré-requisitos
- Repo no GitHub (Railway e Vercel puxam de lá).
- Contas: Vercel, Supabase, Railway.
- Gere segredos fortes (uma vez): `openssl rand -hex 32` para `INTEGRATIONS_ENCRYPTION_KEY` e `INTERNAL_API_SECRET`.

---

## Passo 1 — Supabase (Postgres + Auth)
1. Já existe o projeto (`noxgldqtfxfqajzhyoia`). Em produção, prefira um projeto **separado** de dev.
2. Anote: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Settings → API) e `DATABASE_URL` (Settings → Database → **Session pooler**, porta 5432, `sslmode=require`, senha URL-encoded).
3. Auth → confirme o provider Email ligado. Adicione o domínio da Vercel em Auth → URL Configuration (redirect/site URL).

## Passo 2 — Railway: infraestrutura de dados
Crie **um projeto** no Railway e adicione 3 serviços a partir dos templates:
1. **ClickHouse** — defina `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DB` (ex.: `truvo`/forte/`truvo`). Anote a URL interna (`http://clickhouse.railway.internal:8123`).
2. **Redpanda/Kafka** — anote o broker interno (`redpanda.railway.internal:9092`).
3. **Redis** — anote a URL interna (`redis://default:<senha>@redis.railway.internal:6379`).

> Use **private networking** (`*.railway.internal`) entre os serviços — não exponha CH/Kafka/Redis à internet.

## Passo 3 — Migrações (rodar UMA vez, e a cada mudança de schema)
Do seu terminal, com as env de **produção** exportadas (`DATABASE_URL` do Supabase prod + `CLICKHOUSE_URL/USER/PASSWORD/DB` do Railway — exponha o CH temporariamente ou rode via `railway run`):
```bash
pnpm install
pnpm db:setup     # = drizzle-kit push (Postgres) + ch:migrate (ClickHouse)
```
Alternativa: `railway run --service <clickhouse|api> pnpm db:ch` para rodar dentro da rede do Railway.

## Passo 4 — Railway: API + workers
Crie **3 serviços** apontando para o MESMO repo GitHub; em cada um, defina *Settings → Config-as-code file path*:
1. **api** → `apps/api/railway.json` (healthcheck `/health`; a porta 3333 é detectada do `EXPOSE`).
2. **consumer** → `apps/consumer/railway.json` (pipeline de eventos).
3. **identity-worker** → `apps/consumer/railway.identity.json` (stitching M8).

Configure as **variáveis de ambiente** (ver a matriz no fim). Pontos críticos:
- `INTERNAL_API_URL` (no consumer e no identity-worker) = URL **interna** da api: `http://api.railway.internal:3333`.
- `SCHEDULER_ENABLED=1` (apenas na **api**) para ligar os crons (leader-lock garante 1 execução).
- `NODE_ENV=production` em todos (neutraliza o `TRUVO_DEV_AUTH_BYPASS`).

Gere um domínio público só para a **api** (Settings → Networking → Generate Domain). Anote a URL pública (`https://truvo-api-xxxx.up.railway.app`).

## Passo 5 — Vercel: web
1. New Project → importe o repo → **Root Directory = `apps/web`** (o `vercel.json` já cuida do install/build no monorepo).
2. Env var (Production): `NEXT_PUBLIC_API_URL` = a **URL pública da api** no Railway (passo 4).
3. Deploy. Anote o domínio da Vercel (`https://truvo.vercel.app` ou o seu domínio).

## Passo 6 — Ligar as pontas + smoke test
1. Na **api** (Railway), setar `CORS_ORIGINS` = domínio(s) da Vercel (csv), ex.: `https://truvo.vercel.app`. Redeploy da api.
2. Smoke test:
   - `curl https://<api>/health` → `{"status":"ok"}`
   - `curl https://<api>/health/ready` → `200` com `clickhouse/postgres/redis/kafka: ok`
   - Abra o web, faça login (Supabase), confira que os dados carregam (modo live).
3. Preencha as credenciais opcionais quando quiser ligar cada módulo (ver matriz): Stripe (M11), Ads (M10), Anthropic (M17), email (M12), e as credenciais CAPI-out (M9) entram pela própria UI (cifradas com `INTEGRATIONS_ENCRYPTION_KEY`).

---

## Matriz de variáveis de ambiente
Fonte de verdade: `.env.example`. Onde cada uma vai:

| Variável | api | consumer | identity | web | Observação |
|---|:--:|:--:|:--:|:--:|---|
| `NODE_ENV=production` | ✅ | ✅ | ✅ | — | neutraliza bypass de auth |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | — | — | service-role só no backend (regra 3) |
| `DATABASE_URL` | ✅ | — | — | — | Supabase session pooler (5432, sslmode=require) |
| `CLICKHOUSE_URL/USER/PASSWORD/DB` | ✅ | ✅ | ✅ | — | interno do Railway |
| `KAFKA_BROKERS` | ✅ | ✅ | ✅ | — | `redpanda.railway.internal:9092` |
| `REDIS_URL` | ✅ | ✅ | ✅ | — | interno do Railway |
| `INTERNAL_API_SECRET` | ✅ | ✅ | ✅ | — | mesmo segredo nos 3 (server-to-server) |
| `INTERNAL_API_URL` | — | ✅ | ✅ | — | `http://api.railway.internal:3333` |
| `INTEGRATIONS_ENCRYPTION_KEY` | ✅ | — | — | — | ≥32 bytes; destrava M4/M9 |
| `CORS_ORIGINS` | ✅ | — | — | — | domínio(s) da Vercel |
| `SCHEDULER_ENABLED=1` | ✅ | — | — | — | liga os crons (só na api) |
| `NEXT_PUBLIC_API_URL` | — | — | — | ✅ | URL pública da api (Railway) |
| Stripe / Ads / Anthropic / Email `*` | ✅ | — | — | — | opcionais, fail-closed sem elas |

---

## Notas & pegadinhas
- **Buildar as imagens antes** — os `Dockerfile`s nunca foram buildados de verdade (dev estava offline). Rode `docker build -f apps/api/Dockerfile .` (e consumer/web) localmente uma vez para pegar ajustes de path do monorepo antes do 1º deploy no Railway.
- **2 processos do consumer** — pipeline (M2) e stitching (M8) são serviços **separados**; escalam independente. Mesma imagem, `startCommand` diferente (já nos `railway.json`).
- **Ordem de boot** — a api valida env no start (`validateEnv`, fail-fast) e conecta Kafka; suba a infra (passo 2) **antes** da api/consumer.
- **Migrações em ClickHouse já populado** — o `ch:migrate` é idempotente (`IF NOT EXISTS`), mas mudanças de schema em tabelas com dados podem exigir `ALTER`/backfill manual.
- **Persistência** — CH/Redpanda no Railway servem para começar; para produção séria com backup/retention, considere ClickHouse Cloud, Redpanda Cloud e Upstash Redis (só troque as URLs nas envs).
- **CI** — `.github/workflows/ci.yml` roda typecheck+build+test em push/PR; configure o repo no GitHub para exigir o check verde antes de merge.
