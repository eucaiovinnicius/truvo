# PRD — Truvo
## Product Requirements Document — Fonte de verdade do produto

> **Versão 3.2 — Julho 2026**
> Leia antes de implementar qualquer feature. Este documento é a fonte de verdade.
> Produto: **Truvo** — SaaS de funnel tracking, attribution e analytics.
>
> **Mudanças da v3.0 → v3.2:** adicionados três módulos novos — **M15 Customer Profile /
> User 360** (timeline navegável do usuário), **M16 Data Explorer** (motor de query próprio:
> explorador visual no-code + SQL guardado, insights self-serve) e **M17 AI Journey
> Intelligence** (IA ancorada em dado reconciliado). Novas regras de negócio 14–20, Anthropic
> como subprocessador, novos riscos R11/R12 e telas correspondentes. Fronteiras entre
> M15/M16/M17 e decisões pendentes registradas no fim da seção 7.
>
> **Mudanças da v2.0 → v3.0:** adicionadas as seções que faltavam para tornar o PRD
> acionável como plano de construção — Roadmap por fases (ordem de dependências),
> Riscos & Dependências, Validação & Qualidade de Dados, Observabilidade, Compliance
> aprofundado (consentimento, DPA, exclusão em ClickHouse), e três novos módulos
> (Notificações, Relatórios, Qualidade de Dados). Decisões de arquitetura fixadas
> (Supabase na nuvem para dev, front-end greenfield em Next.js). Ver changelog no fim.

---

## 0. DECISÕES DE PROJETO (fixadas — não reabrir sem justificativa)

Estas decisões já foram tomadas e valem para todo o desenvolvimento:

1. **Escopo:** construir o produto **completo** (todos os módulos). Não há corte de MVP
   por pressa de mercado. O que orienta a ordem é **dependência técnica**, não prioridade
   comercial (ver seção 6 — Roadmap).
2. **Stack:** seguir a stack da seção 3 **à risca** desde a Fase 0. Sem simplificações
   temporárias de infra.
3. **Ambiente de desenvolvimento:**
   - **Auth + PostgreSQL:** Supabase **na nuvem** (free tier) desde o início.
   - **ClickHouse, Redpanda (Kafka), Redis:** **locais via Docker Compose** durante o dev,
     migrando para Railway em staging/prod.
4. **Protótipo existente é descartável.** O código atual do repositório (Vite + React 19 +
   `@google/genai`) é **referência visual apenas**. O produto será construído **greenfield
   em Next.js 14**. O protótipo Vite não deve ser evoluído — deve ser preservado em
   `/_reference` e ignorado pelo build principal.
5. **Um módulo por vez, rodando de verdade** antes de avançar. Nada de 11 módulos meio-prontos.

---

## 1. VISÃO DO PRODUTO

### Nome
**Truvo** — de "trust" (confiança) + "trovar" (descobrir, revelar).
Tagline: **"Dados que você pode confiar."**

### Problema
Marketers e agências tomam decisões de budget com dados errados:
- iOS 14.5+ destruiu o tracking por pixel (opt-in < 25% em mobile).
- Ad-blockers bloqueiam 30–40% do tráfego.
- ROAS reportado pelo Meta é inflado — conta conversões que não existem.
- A jornada real do cliente passa por 3 dispositivos — nenhuma ferramenta enxerga completo.
- Funis são desenhados no Funnelytics (visual, sem dados) e medidos no GA4 (dados, sem visual).

### Solução
Plataforma unificada que:
1. Captura eventos via server-side (não depende de cookie ou browser).
2. Mostra o funil completo com dados reais e drop-off por step.
3. Atribui cada conversão ao canal correto com múltiplos modelos.
4. Mostra qual criativo realmente converteu (vs o que a plataforma reporta).
5. Centraliza tudo num dashboard customizável.

### Proposta de valor em uma linha
> "Veja cada conversão. Entenda cada funil. Escale com precisão."

### O diferencial defensável — "o delta"
A métrica que valida o produto inteiro é o **delta entre o que as plataformas reportam
e o que realmente acontece**. Se o cliente vê mais conversões *reais e reconciliadas* no
Truvo do que no painel do Meta, ele não cancela.

> ⚠️ **Atenção crítica (ver seção 10):** "mais conversões" só é um diferencial se for
> **verdade reconciliada** — bater com a receita real do gateway (Shopify/Stripe). Um número
> maior por over-attribution é um **bug vendido como feature**. A metodologia de validação
> é parte do produto, não um detalhe.

---

## 2. PÚBLICO-ALVO (ICP)

### ICP 1 — Agências de Performance (primário)
- Gerenciam 5–30 clientes com budget de R$20k–R$500k/mês em ads.
- Precisam provar ROI real para clientes.
- Dor: dados fragmentados, relatórios manuais, ferramentas não integradas.
- Pagam: R$1.500–R$3.000/mês.
- Precisam de: white-label, multi-workspace, **relatórios automáticos** (ver Módulo 13).

### ICP 2 — Marcas DTC / Ecommerce (secundário)
- Faturamento R$500k–R$20M/ano, vendem em múltiplos canais.
- Dor: ROAS do Meta mente, não sabem qual canal gera caixa de verdade.
- Pagam: R$500–R$1.500/mês.
- Precisam de: integração Shopify/Stripe, attribution por canal.

### ICP 3 — Infoprodutores e Lançadores (terciário)
- Funis complexos com 8–15 steps (captação → webinar → oferta → upsell).
- Dor: não sabem onde o lead some no funil.
- Pagam: R$300–R$700/mês.
- Precisam de: funnel builder simples, tracking de lead a venda.

---

## 3. STACK TÉCNICA

| Camada | Tecnologia | Deploy (prod) | Dev |
|---|---|---|---|
| Frontend | Next.js 14 (App Router) + Tailwind + Shadcn/ui | Vercel | local |
| Backend | NestJS + Node 20 + TypeScript strict | Railway | local |
| Auth + DB | Supabase (PostgreSQL + Auth + RLS) | Supabase Cloud | **Supabase Cloud (free tier)** |
| Eventos | ClickHouse | Railway | **Docker local** |
| Queue | Redpanda (Kafka-compatible) | Railway | **Docker local** |
| Cache | Redis | Railway | **Docker local** |
| Billing | Stripe | — | Stripe test mode |
| ORM | Drizzle ORM | — | — |
| Monorepo | Turborepo + pnpm workspaces | — | — |

**Node:** 20 LTS (a máquina de dev roda 20.11 — considerar atualizar para 20.19+ para
compatibilidade plena com plugins recentes).

### Layout do monorepo (Turborepo + pnpm)
```
truvo/
├── apps/
│   ├── web/          # Next.js 14 (App Router) — dashboard
│   ├── api/          # NestJS — REST + webhooks + ingestão
│   └── consumer/     # NestJS worker — consumidor Kafka → ClickHouse
├── packages/
│   ├── event-schema/ # EventSchema + validação (zod), compartilhado por todos
│   ├── pixel/         # Pixel JS (<5kb), build isolado
│   ├── db/            # Drizzle schema + migrations (Postgres) + clients ClickHouse
│   ├── config/        # tsconfig, eslint, env schema compartilhados
│   └── ui/            # Componentes Shadcn compartilhados
├── infra/
│   └── docker-compose.yml   # ClickHouse + Redpanda + Redis (dev local)
├── _reference/       # protótipo Vite antigo (referência visual, não buildado)
└── turbo.json
```

---

## 4. EVENT MODEL

Todo evento — independente da fonte — é normalizado para este schema:

```json
{
  "event_id": "evt_01HX...",
  "event_name": "purchase",
  "source": "webhook",
  "timestamp": "2026-05-10T14:32:00Z",
  "received_at": "2026-05-10T14:32:01Z",
  "workspace_id": "ws_abc123",
  "anonymous_id": "anon_XYZ",
  "user_id": "usr_456",
  "session_id": "sess_789",
  "click_id": "clk_012",
  "order_id": "ord_345",
  "properties": {
    "value": 297.00,
    "currency": "BRL",
    "items": [{ "id": "prod_1", "name": "Curso X", "price": 297.00 }]
  },
  "context": {
    "utm_source": "facebook",
    "utm_medium": "paid",
    "utm_campaign": "lancamento_maio",
    "utm_content": "video_depoimento",
    "utm_term": "",
    "page_url": "https://site.com/obrigado",
    "referrer": "https://site.com/checkout",
    "user_agent": "Mozilla/5.0...",
    "ip": "189.x.x.x",
    "ip_country": "BR",
    "ip_city": "São Paulo",
    "device_type": "mobile",
    "os": "iOS",
    "browser": "Safari"
  }
}
```

### Eventos padrão do sistema

| Evento | Descrição | Fonte típica |
|---|---|---|
| page_view | Visita a uma página | Pixel |
| session_start | Início de sessão | Pixel |
| button_click | Clique em elemento | Pixel |
| form_submit | Envio de formulário | Pixel / Server |
| lead | Lead capturado | Server / Webhook |
| checkout_started | Início de checkout | Pixel / Webhook |
| checkout_completed | Checkout finalizado | Server / Webhook |
| purchase | Compra confirmada | Webhook / API |
| refund | Reembolso | Webhook |
| subscription_started | Assinatura criada | Webhook |
| subscription_cancelled | Assinatura cancelada | Webhook |
| identify | Identificação do usuário | Pixel / Server |
| custom | Evento personalizado | Qualquer fonte |

### Prioridade de fontes (deduplicação)
```
1. webhook    (mais confiável)
2. api
3. gateway
4. redirect
5. pixel
6. url        (menos confiável)
```

### Deduplicação — janelas e casos de borda
- **Por `event_id`:** idempotência. Janela padrão **24h no Redis** (TTL). ⚠️ Eventos
  duplicados que cheguem **após 24h** escapam desta camada — por isso a dedup por
  `order_id` (abaixo) é obrigatória para conversões, e o ClickHouse usa `ReplacingMergeTree`
  como rede de segurança final por `event_id`.
- **Por `order_id`:** prioridade por fonte (webhook > api > gateway > redirect > pixel > url).
  Toda conversão passa por esta camada, sem janela de tempo (comparação persistente).
- **Registro de descarte:** todo evento descartado é logado com motivo e fonte "ganhadora".

---

## 5. ARQUITETURA & AMBIENTES

### Ambientes
| Ambiente | Uso | Infra |
|---|---|---|
| **dev (local)** | desenvolvimento | Supabase Cloud (free) + Docker (ClickHouse/Redpanda/Redis) |
| **staging** | homologação | Vercel + Railway + Supabase (projeto separado) |
| **prod** | produção | Vercel + Railway + Supabase (projeto prod) |

### Fluxo de dados (alto nível)
```
Fontes                         Ingestão              Processamento          Storage         Consumo
─────────────────────────────────────────────────────────────────────────────────────────────────
Pixel JS ─┐                                          ┌─ dedup (Redis)
Webhooks ─┼─► POST /v1/events ─► valida ─► Kafka ─────┼─ enrich (geo+device) ─► ClickHouse ─► Dashboards
API      ─┘   (retorna 200)      (zod)   (Redpanda)   ├─ identity stitch                     Funis
Tracking                                              └─ order_id dedup       Postgres        Attribution
link /c/:code                                                                (config/meta)    Creatives
                                                                                              CAPI out
```

### Regra de resposta síncrona
`POST /v1/events` **valida e retorna 200 imediatamente** (< 200ms p99). Todo processamento
(dedup, enrich, insert) é **assíncrono via Kafka**. Nunca bloquear o cliente no processamento.

---

## 6. ROADMAP DE CONSTRUÇÃO POR FASES

> Isto **não** é priorização comercial (o escopo é tudo). É a **ordem obrigatória de
> dependências**: cada módulo só pode ser construído depois do que ele consome.

| Fase | Módulo | Depende de | Entrega |
|---|---|---|---|
| **0** | **Fundação** | — | Monorepo, pacotes compartilhados (event-schema, db, config, ui), `docker-compose` (ClickHouse/Redpanda/Redis), projeto Supabase, esqueletos NestJS + Next.js, Drizzle + migrations, health checks, CI |
| **1** | **M1 — Auth & Workspaces** | 0 | Base multi-tenant. Tudo filtra por `workspace_id` |
| **2** | **M2 — Event Pipeline** | 1 | A espinha dorsal. Ingestão, Kafka, ClickHouse, dedup por `event_id`, enrich, rate limit, debug view |
| **3** | **M3 — Tracking Layer** | 2 | Pixel JS (<5kb), tracking links, captura de UTM/click_id |
| **3** | **M4 — Webhook Receivers** | 2 | Shopify/Stripe/Hotmart/Kiwify, HMAC, normalização, logs+retry *(paralelo com M3)* |
| **4** | **M8 — Identity + Dedup avançado** | 2·3·4 | Identity graph, user stitching, dedup por `order_id`, stitching retroativo |
| **5** | **M14 — Qualidade de Dados & Reconciliação** | 2·4·8 | Reconciliação com gateway, filtragem de bots, monitor de discrepância. **Valida a tese antes de construir o resto** |
| **6** | **M5 — Funnel Engine** | eventos+identity | Steps, drop-off, filtros, preview, alertas, export |
| **7** | **M6 — Metrics + Dashboard Builder** | eventos+funis | KPIs nativos/custom, segmentação, builder, templates, share |
| **8** | **M7 — Attribution Engine** | identity+touchpoints | 5 modelos, windows, conversion paths, assisted, breakdown |
| **9** | **M9 — Integrations OUT** | 4·8 | Meta CAPI, Google Enhanced, TikTok Events |
| **10** | **M10 — Creative Analytics** | 7·9 | Cruza Ads API com conversões reais — "o delta" |
| **Transversal** | **M11 — Billing** | 1 (+contador do M2) | Plumbing pode começar após M1; feature gates ligados conforme features nascem |
| **Transversal** | **M12 — Notificações & Alertas** | 1 | Infra de e-mail/Slack/in-app; alertas dos M5/M10/M14 dependem dela |
| **Transversal** | **M13 — Relatórios** | 6·7 | Relatórios agendados e white-label (crítico para ICP 1) |
| **Transversal** | **M15 — Customer Profile / User 360** | 8·2·7 | Timeline navegável do usuário (anônimo→identificado) + perfil consolidado. Identidades/Timeline pós-M8; Jornada pós-M7 *(novo v3.2)* |
| **9** | **M16 — Data Explorer** | 2·1·6·14·8·11 | Motor de query próprio: explorador visual no-code + SQL guardado (sandbox); insights self-serve → dashboards *(novo v3.2)* |
| **11** | **M17 — AI Journey Intelligence** | 7·14·16·(10)·12·11 | IA ancorada em dado reconciliado: melhores jornadas por canal por objetivo (deterministic-first + Claude) *(novo v3.2)* |

**Regra de gate entre fases:** um módulo só é considerado "pronto" quando roda de verdade
(app real exercitado end-to-end), com testes e observabilidade mínima. Ver seção 13.

> **Marco de validação (Fase 5):** antes de investir nos módulos analíticos pesados
> (M5→M10), o M14 deve provar, com dados reais de ao menos 1 cliente, que os números do
> Truvo **reconciliam com a receita real** do gateway. Isto valida ou mata a tese central.

---

## 7. MÓDULOS DO PRODUTO

---

### MÓDULO 1 — AUTH E WORKSPACES

#### Funcionalidades
- Signup com email + senha (via Supabase Auth).
- Login com JWT + refresh token automático.
- Multi-tenant: workspaces isolados por RLS no Supabase.
- Convite de membros por email.
- Roles: owner, admin, member, viewer.
- Workspace selector na sidebar (troca de workspace).
- Configurações de workspace: nome, slug, logo, timezone, moeda, retenção de dados.

#### Roles e permissões

| Ação | Owner | Admin | Member | Viewer |
|---|:---:|:---:|:---:|:---:|
| Ver dados | ✅ | ✅ | ✅ | ✅ |
| Criar funis/dashboards | ✅ | ✅ | ✅ | ❌ |
| Gerenciar integrações | ✅ | ✅ | ❌ | ❌ |
| Gerenciar membros | ✅ | ✅ | ❌ | ❌ |
| Billing | ✅ | ❌ | ❌ | ❌ |
| Deletar workspace | ✅ | ❌ | ❌ | ❌ |

#### Endpoints
```
POST   /v1/auth/signup
POST   /v1/auth/login
POST   /v1/auth/logout
POST   /v1/auth/refresh
GET    /v1/users/me
PATCH  /v1/users/me
GET    /v1/workspaces
POST   /v1/workspaces
GET    /v1/workspaces/:id
PATCH  /v1/workspaces/:id
DELETE /v1/workspaces/:id
POST   /v1/workspaces/:id/invite
PATCH  /v1/workspaces/:id/members/:userId
DELETE /v1/workspaces/:id/members/:userId
```

---

### MÓDULO 2 — EVENT PIPELINE

#### Funcionalidades
- Endpoint de ingestão single + batch (até 500 eventos).
- API Keys por workspace (geração, hash SHA-256, revogação).
- Rate limiting por workspace e por plano (Redis).
- Contador mensal de eventos por workspace (Redis) — insumo do billing e feature gates.
- Kafka producer: enfileirar eventos após validação.
- Kafka consumer: processar → enriquecer → inserir no ClickHouse.
- Deduplicação por `event_id` (ReplacingMergeTree + Redis).
- Deduplicação por `order_id` (prioridade por fonte).
- Debug view: últimos 50 eventos em tempo real por workspace.
- Volume chart: eventos por hora/dia.
- **Filtragem de bots na ingestão** (ver Módulo 14) — antes de contar para billing.

#### Enriquecimento automático de evento
```
ip         → ip_country + ip_city (via MaxMind GeoIP)  [ip descartado após enrich]
user_agent → device_type + os + browser
timestamp  → recalcular se ausente (usar received_at)
```

#### Endpoints
```
POST /v1/events              (auth: API key)
POST /v1/events/batch        (auth: API key)
GET  /v1/events/recent       (últimos 50, auth: JWT)
GET  /v1/events/volume       (por hora/dia, auth: JWT)
GET    /v1/api-keys
POST   /v1/api-keys
DELETE /v1/api-keys/:id
```

#### Lógica do consumer (assíncrono)
```
1. Consumir mensagem do Kafka
2. Deduplicar por event_id (Redis, TTL 24h)
3. Se order_id presente: verificar prioridade de fonte
4. Filtrar bot (user_agent/IP suspeito) → marcar is_bot
5. Enriquecer: geo + device
6. Batch insert no ClickHouse (100 eventos ou 1s)
7. Incrementar contador mensal no Redis (apenas eventos não-bot para billing)
```

---

### MÓDULO 3 — TRACKING LAYER

#### Pixel JS (packages/pixel)
- Bundle **< 5kb** minificado + gzip.
- Carregamento assíncrono (não bloqueia render).
- Geração de `anonymous_id` → cookie first-party (SameSite=Lax, 1 ano).
- Geração de `session_id` → sessionStorage (expira 30min inatividade).
- Captura de `click_id` da URL → cookie first-party.
- Captura de UTMs da URL → sessionStorage.
- Captura de `fbclid`, `gclid`, `ttclid`.
- Eventos automáticos: page_view, session_start, button_click (`data-track`), form_submit,
  scroll_depth (25/50/75/100%).
- API pública: `window.truvo.track(event_name, properties)`.
- `window.truvo.identify(user_id, { email, name, phone })`.
- Envio para `POST /v1/events` com API key do workspace.
- **Respeita consentimento:** se o consent manager (ver seção 11) negar tracking,
  o pixel não seta cookies nem envia PII.

#### URL Tracking / Tracking Links
- Gerador de tracking links com UTMs configuráveis.
- Redirect preservando todos os parâmetros: `/c/:code`.
- `click_id` gerado no redirect e salvo em cookie.
- Contador de cliques por link.
- Stats por link: cliques, sessões, conversões.

#### Endpoints
```
GET /c/:code                     (público, redirect, < 100ms)
GET /pixel.js                    (CDN Vercel)
GET    /v1/tracking/links
POST   /v1/tracking/links
GET    /v1/tracking/links/:id
PATCH  /v1/tracking/links/:id
DELETE /v1/tracking/links/:id
GET    /v1/tracking/links/:id/stats
```

---

### MÓDULO 4 — WEBHOOK RECEIVERS

#### Integrações de entrada (recebe dados)

**Shopify** — verificação HMAC-SHA256 obrigatória.
- `orders/paid` → purchase · `orders/refunded` → refund
- `checkouts/create` → checkout_started · `checkouts/complete` → checkout_completed
- Campos: order_id, value, currency, email_hash, items, customer_id.

**Stripe**
- `payment_intent.succeeded` → purchase · `charge.refunded` → refund
- `customer.subscription.created` → subscription_started
- `customer.subscription.deleted` → subscription_cancelled · `invoice.paid` → payment_received

**Hotmart** — `purchase.complete` → purchase · `purchase.refunded` → refund
**Kiwify** — `order.paid` → purchase · `order.refunded` → refund

#### Normalização de payload → EventSchema
Cada webhook é transformado para o EventSchema padrão antes de entrar na fila Kafka.

#### Webhook logs & retry
- Cada webhook logado: timestamp, tipo, status, payload resumido, erro.
- Retry automático em falha (3 tentativas, backoff exponencial: 1min, 5min, 15min).

#### Endpoints
```
POST /v1/webhooks/shopify
POST /v1/webhooks/stripe
POST /v1/webhooks/hotmart
POST /v1/webhooks/kiwify
GET    /v1/integrations
POST   /v1/integrations
GET    /v1/integrations/:id
PATCH  /v1/integrations/:id
DELETE /v1/integrations/:id
POST   /v1/integrations/:id/test
GET    /v1/integrations/:id/logs
```

---

### MÓDULO 5 — FUNNEL ENGINE

#### O que é um funil
Sequência de steps configuráveis. Cada step é definido por um `event_name` e condições
opcionais: `url_contains`, `element_id`, `property_eq`, `property_gte`.

#### Schema de funil (JSONB)
```json
{
  "funnel_id": "fnl_abc",
  "name": "Funil de Lançamento",
  "attribution_window_days": 7,
  "steps": [
    { "step_id": "s1", "name": "Visitou a landing page", "event": "page_view", "conditions": { "url_contains": "/lp" } },
    { "step_id": "s2", "name": "Clicou no botão", "event": "button_click", "conditions": { "element_id": "btn-comprar" } },
    { "step_id": "s3", "name": "Iniciou checkout", "event": "checkout_started", "conditions": {} },
    { "step_id": "s4", "name": "Comprou", "event": "purchase", "conditions": {} }
  ]
}
```

#### Métricas por step
- `users_entered`, `users_converted`, `conversion_rate`, `drop_off_rate`, `avg_time_to_next`.

#### Métricas do funil completo
- `overall_conversion_rate`, `top_drop_off_step`, `best_traffic_source`, `revenue_per_visitor`.

#### Funcionalidades
- CRUD de funis por workspace.
- Cálculo de conversão com attribution window.
- Drop-off: lista de usuários que saíram em cada step.
- Filtros: período, utm_source, utm_medium, device_type, ip_country.
- Comparação de períodos (atual vs anterior).
- Preview em tempo real no builder (contagem dos últimos 30 dias).
- Alertas (via M12): notificar se conversão cair abaixo de X%.
- Export: CSV de usuários por step.

#### Endpoints
```
GET    /v1/funnels
POST   /v1/funnels
GET    /v1/funnels/:id
PATCH  /v1/funnels/:id
DELETE /v1/funnels/:id
GET    /v1/funnels/:id/stats?start=&end=&utm_source=&device_type=
GET    /v1/funnels/:id/dropoff/:stepId
GET    /v1/funnels/:id/preview
```

---

### MÓDULO 6 — METRICS / KPI LAYER

#### KPIs nativos
```
ROAS = sum(revenue) / sum(ad_spend)
CAC  = sum(ad_spend) / count(DISTINCT user_id com purchase)
LTV  = AOV × avg_orders_per_user
AOV  = sum(revenue) / count(DISTINCT order_id)
CVR  = count(purchase) / count(DISTINCT session_id) × 100
CPL  = sum(ad_spend) / count(lead)
MRR  = sum(subscription_value)  (para SaaS)
```

#### KPIs customizados (fórmula visual, sem SQL)
```json
{
  "name": "Taxa de Ativação",
  "formula": {
    "numerator":   { "event": "feature_used", "aggregation": "count" },
    "denominator": { "event": "signup", "aggregation": "count" },
    "multiplier": 100
  },
  "filters": { "period": "last_30_days" },
  "segment_by": ["utm_source", "device_type"]
}
```

#### Segmentação
Qualquer KPI pode ser segmentado por: utm_source/medium/campaign/content, device_type,
ip_country/city, os, browser, ou qualquer propriedade de evento.

#### Dashboard Builder
- Widgets: KPI card, line chart, bar chart, pie/donut, funnel chart, tabela, heatmap, cohort.
- Grid de 12 colunas, drag-and-drop, widgets redimensionáveis.
- Filtros globais: date range, segmento, fonte (afetam todos os widgets).
- Drill-down: clique em ponto → sheet com eventos subjacentes.
- Templates prontos: Ecommerce Overview, Funil de Lançamento, Ads Performance, Client Report.
- Compartilhamento: link read-only (com ou sem senha).
- Export: PNG do dashboard, CSV por widget.

#### Endpoints
```
GET /v1/metrics/kpis?start=&end=&utm_source=&device_type=
GET /v1/metrics/timeseries?metric=revenue&granularity=day&start=&end=
GET /v1/metrics/breakdown?metric=revenue&dimension=utm_source&start=&end=
GET    /v1/kpis
POST   /v1/kpis
PATCH  /v1/kpis/:id
DELETE /v1/kpis/:id
GET    /v1/dashboards
POST   /v1/dashboards
GET    /v1/dashboards/:id
PATCH  /v1/dashboards/:id
DELETE /v1/dashboards/:id
GET    /v1/dashboards/:id/data
GET    /v1/dashboards/public/:token   (público, sem auth)
```

---

### MÓDULO 7 — ATTRIBUTION ENGINE

#### Modelos suportados
- **Last Click** — 100% para o último touchpoint. Favorece fundo de funil.
- **First Click** — 100% para o primeiro. Favorece descoberta.
- **Linear** — crédito dividido igualmente.
- **Position-based (U-shaped)** — 40% primeiro, 40% último, 20% no meio.
- **Time Decay** — crédito ∝ `e^(-λ × dias_antes_da_conversão)`.

#### Attribution window
Configurável por workspace: 1, 7, 14, 30 dias.

#### Conversion paths
Sequência de touchpoints por conversão.
Ex.: `["facebook_paid", "google_organic", "facebook_paid"]` → 234 conversões.

#### Assisted conversions
Canais que participaram mas não foram last-touch. Evita que topo de funil pareça ineficiente.

#### Campaign breakdown
Hierarquia navegável: Canal → Campanha → Conjunto → Anúncio (via UTMs).
Tabela: utm_campaign, conversões, receita atribuída, ROAS, CAC, spend.

#### Endpoints
```
GET /v1/attribution/report?model=last_click&start=&end=&window=7
GET /v1/attribution/compare?models=last_click,linear&start=&end=
GET /v1/attribution/paths?start=&end=&limit=20
GET /v1/attribution/campaign-breakdown?channel=facebook&model=linear&start=&end=
```

---

### MÓDULO 8 — IDENTITY RESOLUTION + DEDUPLICATION

#### Identity Graph
Conecta todos os identificadores de um mesmo usuário:
```
click_id: clk_abc
    ├── anonymous_id: anon_111 (mobile, dia 1)
    ├── anonymous_id: anon_222 (desktop, dia 3)
            └── user_id: usr_456 (após compra)
                    ├── email_hash: sha256(email)
                    └── order_id: ord_789
```

#### User Stitching
- Trigger: evento `identify` ou `purchase` com email.
- Ação: merge anonymous_id → user_id via email_hash.
- Retroactive: atualizar user_id em eventos históricos.

#### Deduplicação avançada
- Por `event_id`: idempotência (janela 24h no Redis).
- Por `order_id`: prioridade por fonte (webhook > api > gateway > redirect > pixel > url).
- Log de eventos descartados com motivo e fonte "ganhadora".
- Retroactive stitching: recalcular funis e attribution após merge.

> ⚠️ **Ponto de risco técnico (ver seção 15):** o stitching retroativo é o processamento mais
> pesado e propenso a inconsistência do sistema. Precisa ser **idempotente e reprocessável**,
> com fila dedicada e checkpoints. É o maior spike técnico do projeto — tratar como tal.

#### Email hash matching
SHA-256 do email normalizado (lowercase, trim) para Meta CAPI e Google.

#### Endpoints
```
GET  /v1/identity/lookup?identifier=anon_abc&type=anonymous_id
POST /v1/identity/identify
GET  /v1/identity/merges
```

---

### MÓDULO 9 — EXTERNAL INTEGRATIONS (saída de dados)

> **Dependência externa crítica (ver seção 16):** cada integração exige aprovação/verificação
> na plataforma (Meta App Review + Business Verification, Google Ads API developer token,
> TikTok Marketing API). São semanas de burocracia e **caminho crítico** — iniciar já,
> em paralelo ao desenvolvimento, pois não dependem de código.

#### Meta Conversions API (CAPI)
- Envio server-side para cada evento de conversão.
- Match keys: email_hash, phone_hash, ip_address, user_agent, fbclid, external_id.
- Deduplicação: `event_id` para evitar dupla contagem pixel + CAPI.
- Monitor de Event Match Quality (salvo em integration_logs).
- Eventos: purchase, lead, InitiateCheckout, CompleteRegistration.

#### Google Enhanced Conversions
- Upload de conversões com email hash via Google Ads API.
- Campos: conversion_action_id, conversion_time, value, email_hash, gclid.
- Offline Conversion Import para vendas com delay.

#### TikTok Events API
- Envio server-side de conversões.
- Match keys: email_hash, phone_hash, ip, user_agent, ttclid.

---

### MÓDULO 10 — CREATIVE ANALYTICS

#### O que é
Cruza dados de criativos (imagens/vídeos dos anúncios) com conversões reais capturadas
server-side. Mostra o **ROAS real por criativo** — não o reportado pela plataforma.

#### Fontes de dados
1. Meta Ads API: criativos, spend, impressões, cliques, CTR, ROAS reportado.
2. Google Ads API: assets, spend, conversões reportadas.
3. TikTok Ads API: criativos de vídeo, spend, métricas.
4. Eventos Truvo: conversões reais via fbclid/gclid/ttclid → ad_id.

#### Métricas por criativo
- **Reportado:** spend, impressões, cliques, CTR, ROAS reportado, CAC reportado.
- **Real (Truvo):** conversões reais, receita real, ROAS real, CAC real.
- **Delta (o insight):** `delta_roas`, `delta_percent`.
  Ex.: "Meta reporta 4.8x. Truvo mede 3.3x. Superestimação de +45%."
- **Funil do criativo:** cliques → sessões → checkouts → compras.

#### Funcionalidades
- Grid de criativos (thumbnail + métricas) e modo tabela configurável.
- Filtros: plataforma, campanha, tipo, fase (TOF/MOF/BOF), período.
- Ordenar por: ROAS real, receita, conversões, spend, delta.
- Sheet de detalhe: preview + métricas + gráfico temporal + jornada dos compradores.
- Comparação de 2–4 criativos: side-by-side + insight automático.
- Scorecard exportável: PNG, PDF, link.
- Alertas automáticos (via M12):
  - **Fadiga:** ROAS caiu >30% em 7 dias → sugerir pausar.
  - **Discrepância alta:** delta > 50% → verificar tracking.
  - **Top performer:** ROAS real > 5x por 7+ dias → aumentar budget.
  - **Gasto sem conversão:** spend > R$500 com 0 conversões reais → pausar.

> ⚠️ **Verificar ToS:** armazenar/reexibir dados de spend e criativos das Ads APIs pode
> esbarrar nos termos de uso das plataformas. Validar antes de construir (ver seção 16).

#### Endpoints
```
GET /v1/creatives?platform=meta&start=&end=&campaign_id=&type=&order_by=roas_real
GET /v1/creatives/:adId
GET /v1/creatives/compare?ad_ids=id1,id2,id3
GET /v1/creatives/:adId/scorecard
GET /v1/creatives/alerts
```

---

### MÓDULO 11 — BILLING

#### Planos

| Plano | Preço | Eventos/mês | Workspaces | Features |
|---|---|---|---|---|
| Starter | R$297/mês | 100k | 1 | Pixel, URL tracking, 3 funis, Dashboard básico |
| Growth | R$697/mês | 1M | 3 | + Server-side, Attribution básica, Integrações, Funis ilimitados |
| Agency | R$1.997/mês | 10M | Ilimitado | + Attribution avançada, Identity resolution, Creative Analytics, White-label |
| Enterprise | Custom | Custom | Ilimitado | + SLA, infra dedicada |

> ⚠️ **Revisão de pricing pendente (ver seção 19):** a curva Starter→Growth é 10x eventos por
> 2,3x preço. Combinada com o custo de ClickHouse/infra por evento, a margem do Growth aperta.
> Modelar custo por evento antes de fixar preços. Eventos de **bot não contam** para o limite.

#### Feature gates por plano
```typescript
starter: ['pixel', 'url_tracking', 'funnels_3', 'dashboard_basic',
          'explorer_visual']
growth:  ['pixel', 'url_tracking', 'funnels_unlimited', 'server_side',
          'attribution_basic', 'integrations', 'dashboard_full',
          'explorer_visual', 'retention_path', 'user_360']
agency:  ['all', 'white_label', 'attribution_advanced',
          'identity_resolution', 'creative_analytics',
          'explorer_sql', 'ai_journey']
// gates novos (v3.2): explorer_visual (todos), retention_path + user_360 (Growth+),
// explorer_sql + ai_journey (Agency/Enterprise, roles owner/admin)
```

#### Stripe
- Products e Prices no Stripe Dashboard.
- Checkout Session para upgrade; Customer Portal para gerenciar assinatura.
- Webhooks: subscription.created/updated/deleted, invoice.paid/failed.
- Usage Records para eventos além do plano (cobrança de excedente).

#### Endpoints
```
GET  /v1/billing/plans
POST /v1/billing/checkout
GET  /v1/billing/portal
GET  /v1/billing/subscription
POST /v1/webhooks/stripe-billing
```

---

### MÓDULO 12 — NOTIFICAÇÕES & ALERTAS *(novo na v3.0)*

#### Por que existe
Os módulos M5 (funil), M10 (criativos) e M14 (qualidade) disparam alertas. Todos precisam de
uma **infraestrutura única de notificação** — sem ela, "alerta" vira código solto em cada módulo.

#### Canais
- **In-app:** central de notificações (sino na topbar), com estado lido/não-lido.
- **Email:** via provedor transacional (Resend/Postmark).
- **Slack:** webhook incoming por workspace (opcional).
- **(futuro)** Webhook out para automações do cliente.

#### Tipos de alerta (registrados por regra)
- Funil: conversão abaixo de X%.
- Criativo: fadiga, discrepância, top performer, gasto sem conversão.
- Qualidade: discrepância de reconciliação > limiar, lag do consumer, integração com erro.
- Billing: aproximando do limite de eventos, pagamento falhou.

#### Funcionalidades
- CRUD de regras de alerta por workspace.
- Preferências de canal por usuário e por tipo.
- Deduplicação/agrupamento (não spammar o mesmo alerta).
- Histórico de alertas disparados.

#### Endpoints
```
GET    /v1/notifications                 (in-app, do usuário)
PATCH  /v1/notifications/:id/read
GET    /v1/alerts/rules
POST   /v1/alerts/rules
PATCH  /v1/alerts/rules/:id
DELETE /v1/alerts/rules/:id
GET    /v1/notifications/preferences
PATCH  /v1/notifications/preferences
```

---

### MÓDULO 13 — RELATÓRIOS (agendados + white-label) *(novo na v3.0)*

#### Por que existe
O ICP 1 (agências) **precisa** de "relatórios automáticos" para provar ROI ao cliente final.
Estava na proposta de valor mas não era módulo. Sem isto, o plano Agency não se justifica.

#### Funcionalidades
- **Relatórios agendados:** frequência (diário/semanal/mensal), a partir de um dashboard.
- **White-label:** logo, cores e domínio do próprio cliente (agência) no relatório.
- **Formatos:** PDF, link web read-only, envio automático por email para lista de destinatários.
- **Templates:** Client Report, Ads Performance, Funil Mensal.
- **Snapshot:** cada relatório congela os dados do período (não muda depois de enviado).

#### Endpoints
```
GET    /v1/reports
POST   /v1/reports                 (cria relatório/agendamento)
GET    /v1/reports/:id
PATCH  /v1/reports/:id
DELETE /v1/reports/:id
POST   /v1/reports/:id/send        (envio manual/teste)
GET    /v1/reports/:id/history
GET    /v1/reports/public/:token   (público, read-only)
```

---

### MÓDULO 14 — QUALIDADE DE DADOS & RECONCILIAÇÃO *(novo na v3.0)*

#### Por que existe — **é o que valida a tese do produto**
O diferencial do Truvo é mostrar conversões **reais**. "Real" só tem valor se **reconcilia
com a fonte de verdade** (receita do gateway). Este módulo garante que o número do Truvo
não é over-attribution disfarçada de insight. É construído **antes** dos módulos analíticos
pesados (Fase 5 do roadmap) justamente para validar ou matar a tese cedo.

#### Reconciliação com ground truth
- Comparar `sum(revenue)` e `count(purchase)` do Truvo vs. o total real do gateway
  (Shopify/Stripe) no mesmo período.
- Métrica `reconciliation_gap = |truvo_revenue − gateway_revenue| / gateway_revenue`.
- Meta: gap < 2% em condições normais. Gap alto → alerta (M12) e bloqueio de "confiança" no dado.
- Painel de reconciliação por workspace e por dia.

#### Filtragem de bots
- Detectar tráfego não-humano por user_agent (listas conhecidas), padrões de IP,
  ausência de interação, velocidade impossível de navegação.
- Marcar `is_bot` no evento (não deletar — auditável).
- **Eventos de bot não contam** para funis, KPIs, attribution nem para o limite de billing.

#### Monitor de discrepância (plataforma vs Truvo)
- Acompanhar o `delta` do M10 ao longo do tempo por conta de anúncio.
- Delta subitamente muito alto costuma indicar **problema de tracking**, não superioridade —
  alertar em vez de comemorar.

#### Endpoints
```
GET /v1/data-quality/reconciliation?workspace_id=&start=&end=
GET /v1/data-quality/bot-report?start=&end=
GET /v1/data-quality/discrepancy?ad_account=&start=&end=
```

---

### MÓDULO 15 — CUSTOMER PROFILE / USER 360 *(novo na v3.2)*

#### Por que existe
O motor de identity resolution (M8) já existe — o identity graph liga `click_id`, `anonymous_id`, `user_id`, `email_hash` e `order_id` de uma mesma pessoa, faz stitching cross-device e retroativo. Mas hoje esse motor **não tem rosto**: o dado está no banco e ninguém consegue olhar *uma pessoa* e ver a jornada dela do anônimo ao identificado. Este módulo é o **pagamento visual do M8** — a tela onde o operador digita um identificador e vê a linha do tempo navegável de tudo que aquele usuário fez, dia a dia, em todos os dispositivos fundidos.

É o padrão consagrado do mercado: **Segment Personas** (perfil unificado por identity resolution), **PostHog Person Profiles** (linha do tempo de eventos por pessoa), **Amplitude/Mixpanel user profile** (properties + activity stream) e **June** (perfil de conta/usuário). Truvo faz o equivalente, mas sempre subordinado às regras de confiança do produto: hash de PII, exclusão de bots e sinalização de incerteza quando o dado não reconcilia.

> ⚠️ Este módulo **não** cria uma segunda fonte de verdade de identidade. Ele **lê e apresenta** o identity graph do M8. Corrigir merges errados (unmerge) e a lógica de stitching continuam sendo responsabilidade do M8; aqui só há a superfície de leitura (e, no máximo, o gatilho de uma ação de merge que o M8 executa).

#### Busca e localização de um usuário
Ponto de entrada da tela. Um campo único que aceita **cinco tipos de identificador**, resolvidos sempre dentro do `workspace_id` atual:

| Tipo | Como é normalizado antes da busca |
|---|---|
| `email_hash` | e-mail em claro digitado é convertido para SHA-256 (lowercase + trim) no cliente antes de sair; ou cola-se o hash direto |
| `phone_hash` | telefone normalizado para E.164 → SHA-256 |
| `user_id` | as-is |
| `anonymous_id` | as-is |
| `order_id` | as-is (o M8 registra `order_id` como identificador no grafo na compra) |

A busca resolve o termo em `identity_links` → `canonical_id` (a chave estável da pessoa: `usr_...` quando identificada, senão a raiz `anon_...`). O resultado é uma lista de candidatos (normalmente 1) com o cabeçalho resumido, para desambiguação.

> ⚠️ Nunca digitar e-mail em claro que trafegue até o backend: o hash é feito no cliente. A busca por e-mail/telefone só casa se o mesmo algoritmo de normalização foi usado na ingestão (regras 4 e 5).

#### Cabeçalho do perfil (identidade consolidada)
Resumo no topo, montado a partir do identity graph fundido:
- **Status:** `anônimo` vs `identificado` (identificado = existe `email_hash`/`user_id` no grafo).
- **Identidade fundida:** todos os `anonymous_id` e **devices** (device_type + os + browser) já costurados na mesma pessoa, `order_ids` e `click_ids` associados.
- **Primeiro toque / último toque:** canal + UTM + data de cada um (liga com touchpoints do M7).
- **Datas:** `created_at` (primeiro evento visto) e `last_seen_at`.
- **e-mail/telefone:** exibidos **apenas como hash** (com botão "copiar hash"), nunca em claro.

#### Métricas do usuário
Cartões no perfil, todos calculados **excluindo eventos `is_bot`** (regra 11):
- **LTV** (soma de `revenue` reconciliada), **nº de pedidos** (`count distinct order_id`), **AOV** (`ltv / pedidos`).
- **Sessões** (de `sessions_mv`), **total de eventos**, **dias desde o primeiro toque**.

> ⚠️ Quando o `reconciliation_gap` do período (M14) está acima do limiar, LTV/receita do perfil vêm **marcados como incertos** — não escondemos, mas sinalizamos (regra 12). Um perfil não pode exibir um LTV "confiável" que o gateway não confirma.

#### Jornada de conversão
A sequência de touchpoints (canais) que levou a pessoa a converter — o mesmo dado que alimenta o M7, agora contado no nível do indivíduo:
`facebook_paid (clique) → email → google_organic → facebook_paid (remarketing) → purchase`.
Mostra, por pedido, o caminho completo e qual canal recebeu crédito no modelo selecionado (last_click, linear, etc.), reaproveitando a `touchpoints` do M7 e a resolução do M8.

#### Timeline de eventos
O coração da tela. Todos os eventos da pessoa em ordem cronológica (padrão decrescente):
- **Agrupável por dia** (cabeçalhos de data com contagem por dia).
- **Filtrável** por `event_name`, `source`, `device_type` e período (`start`/`end`).
- **Cada evento é expansível**, revelando `properties` (value, currency, items…) e `context` (utm_*, page_url, referrer, device_type, os, browser, ip_country/ip_city — nunca o IP bruto).
- **Marcadores visuais** para os momentos-chave: `identify` (virada de anônimo→identificado), merge de device, `purchase`, `refund`.
- **Paginação por cursor** `(timestamp, event_id)` — perfis com dezenas de milhares de eventos não podem carregar tudo de uma vez.

#### Como os dados são lidos (identity graph + eventos)
Sempre com `workspace_id` no filtro, em toda etapa:
```
Resolver perfil:
1. Normalizar o termo conforme o `type`
   (email/phone → SHA-256; user/anon/order → as-is)
2. identity_links[workspace_id, identifier] → canonical_id        (Postgres — M8)
   ↳ não achou? 404. NUNCA varrer outro workspace.
3. user_profiles[workspace_id, canonical_id] → cabeçalho + métricas (cache/projeção)
   ↳ cache miss/stale? recomputar a partir do ClickHouse e regravar
4. Timeline (sob demanda, ClickHouse):
   SELECT event_id, event_name, source, timestamp, properties, context
   FROM events
   WHERE workspace_id = :ws
     AND (user_id = :cid OR anonymous_id IN (:merged_anon_ids))
     AND is_bot = 0                         -- regra 11
     AND timestamp BETWEEN :start AND :end
   ORDER BY timestamp DESC
   LIMIT :limit  (cursor por (timestamp, event_id))
5. Jornada: touchpoints[workspace_id, canonical_id] ordenados      (ClickHouse — M7)
6. Identidades: identity_links + identity_merges[workspace_id, canonical_id]  (Postgres — M8)
```
A tabela `user_profiles` (Postgres) é uma **projeção consolidada** (cache) do cabeçalho e das métricas, 1 linha por `canonical_id`, recalculada pelo worker de stitching do M8 após `identify`/`purchase` e após stitch retroativo. Serve para busca e cabeçalho rápidos; a timeline sempre vem fresca do ClickHouse.

Exemplo de resposta consolidada:
```json
{
  "canonical_id": "usr_456",
  "workspace_id": "ws_abc123",
  "status": "identified",
  "email_hash": "sha256:9f86d0...",
  "phone_hash": "sha256:0b7e2c...",
  "identity": {
    "anonymous_ids": ["anon_111", "anon_222"],
    "devices": [
      { "device_type": "mobile",  "os": "iOS",     "browser": "Safari", "first_seen": "2026-05-01T09:12:00Z" },
      { "device_type": "desktop", "os": "Windows", "browser": "Chrome", "first_seen": "2026-05-03T21:40:00Z" }
    ],
    "order_ids": ["ord_789"],
    "click_ids": ["clk_abc"]
  },
  "first_touch": { "channel": "facebook_paid", "utm_source": "facebook", "utm_campaign": "lancamento_maio", "at": "2026-05-01T09:12:00Z" },
  "last_touch":  { "channel": "google_organic", "utm_source": "google", "at": "2026-05-10T14:20:00Z" },
  "created_at": "2026-05-01T09:12:00Z",
  "last_seen_at": "2026-05-10T14:32:00Z",
  "metrics": {
    "ltv": 594.00, "orders_count": 2, "aov": 297.00,
    "sessions_count": 7, "events_count": 143,
    "days_since_first_touch": 9, "currency": "BRL"
  },
  "confidence": { "reconciliation_gap": 0.014, "trusted": true, "excludes_bot_events": true }
}
```

#### Estados de borda honestos
> ⚠️ **Usuário só-anônimo → perfil parcial.** Sem `email_hash`/`user_id` no grafo, não há como costurar dispositivos: cada `anonymous_id` é uma "pessoa" separada. O perfil mostra apenas o que aquele device viu e exibe um aviso explícito de "identidade não consolidada — sem stitch cross-device". Não inventamos fusão que o dado não sustenta.

> ⚠️ **Identidades nunca cruzam workspaces.** O mesmo `email_hash`/`phone_hash` em dois workspaces representa **duas pessoas distintas**. Toda resolução é filtrada por `workspace_id` — jamais unir perfis entre tenants (isolamento multi-tenant, regra 1).

> ⚠️ **LGPD.** E-mail e telefone aparecem só como hash (regras 4/5); IP nunca é exibido, apenas country/city. **Direito ao esquecimento:** ao expurgar o titular (seção 11), o perfil vira *tombstone* e some da busca **imediatamente**, mesmo com a mutation no ClickHouse ainda assíncrona — o perfil nunca "ressuscita" dados já marcados para exclusão. Todo acesso a um perfil individual é registrado em `profile_access_log` (trilha de auditoria de acesso a PII).

#### Endpoints
```
GET /v1/profiles/search?q=&type=email_hash          (busca; type: email_hash|phone_hash|user_id|anonymous_id|order_id)
GET /v1/profiles/:canonicalId                        (perfil consolidado — cabeçalho + métricas)
GET /v1/profiles/:canonicalId/timeline?start=&end=&event_name=&source=&device_type=&group_by=day&cursor=&limit=50
GET /v1/profiles/:canonicalId/identities             (anonymous_ids, devices, order_ids, click_ids + histórico de merges)
GET /v1/profiles/:canonicalId/journey?model=last_click&window=7   (jornada de conversão — touchpoints, liga M7/M8)

# Reuso da seção 11 (LGPD) — não redefinidos aqui:
DELETE /v1/users/:id                                 (direito ao esquecimento — expurga eventos do titular; o perfil vira tombstone)
GET    /v1/users/:id/events                          (portabilidade — export dos dados do titular)
```

---

### MÓDULO 16 — DATA EXPLORER (motor de query próprio) *(novo na v3.2)*

#### Por que existe

Até aqui o Truvo entrega **análises que _nós_ desenhamos**: funis (M5), KPIs e dashboards (M6), attribution (M7), criativos (M10). É poderoso, mas é um teto: o cliente só vê as perguntas que anteciparmos. O Data Explorer inverte isso — dá ao cliente um **motor de exploração** para responder as próprias perguntas, montar as próprias tabelas, gráficos e dashboards sobre os eventos dele. Isso muda o posicionamento do produto de _"dashboards que montamos pra você"_ para _"plataforma de dados que você explora"_ — o território de PostHog (Insights + HogQL), Amplitude e Mixpanel.

Decisão do dono do produto (fixada): **construir um motor próprio**, não embedar Metabase/Superset/terceiro. Motivos: (1) isolamento multi-tenant precisa ser _nosso_ e auditável — não podemos delegar a segurança do dado a um SQL genérico apontando pro cluster compartilhado; (2) o modelo de query próprio é o que nos deixa **injetar `workspace_id`, filtro de bot e marca de incerteza de reconciliação sempre**, sem depender de o cliente lembrar; (3) o motor vira ativo do produto (a "camada semântica" do Truvo), reutilizável por M5/M6/M7 por baixo.

> ⚠️ **Referências, não cópia:** nos inspiramos no **HogQL/Insights (PostHog)**, no query builder do **Amplitude** e no **Mixpanel**. O spec de query, o compilador para SQL ClickHouse e o sandbox são **implementação própria do Truvo** — não reusamos o dialeto nem o runtime de nenhum deles.

---

#### Camada semântica — o modelo de query próprio

O coração do módulo é um **spec de query em JSON que nós possuímos**. O front-end (visual) e o modo SQL avançado produzem esse spec; um **compilador server-side** o transforma em **SQL ClickHouse parametrizado**. O cliente nunca escreve SQL cru contra as tabelas físicas — ele descreve _intenção_, e nós geramos a query segura.

Formato do spec (`ExplorerQuerySpec`):

```json
{
  "insight_type": "trends",
  "source": "events",
  "measures": [
    { "id": "m1", "metric": "count",   "event": "purchase" },
    { "id": "m2", "metric": "sum",     "event": "purchase", "property": "value" },
    { "id": "m3", "metric": "unique",  "event": "purchase", "on": "user_id" }
  ],
  "dimensions": ["context.utm_source", "context.device_type"],
  "filters": {
    "op": "and",
    "conditions": [
      { "field": "context.utm_medium", "op": "eq", "value": "paid" },
      { "field": "properties.value",   "op": "gte", "value": 100 },
      { "field": "event_name",         "op": "in",  "value": ["purchase", "lead"] }
    ]
  },
  "group_by": ["context.utm_source"],
  "date_range": { "preset": "last_30_days" },
  "granularity": "day",
  "order": [{ "by": "m2", "dir": "desc" }],
  "limit": 100,
  "include_bots": false
}
```

**Vocabulário fechado (whitelist):**
- `measure.metric` ∈ `count | unique | sum | avg | min | max | p50 | p90 | p95 | rate`. `unique` mapeia para `uniqExact()`/`uniq()` sobre `on` (ex.: `user_id`, `session_id`, `anonymous_id`). `sum/avg/percentis` exigem `property` numérica.
- `dimensions` / `group_by` / `filters.field` só aceitam **campos do catálogo** (ver "Catálogo de schema"): colunas de topo (`event_name`, `source`, `session_id`, `user_id`…), `context.*` e `properties.*` conhecidas. Qualquer campo fora do catálogo é rejeitado com `422`.
- `filters.op` ∈ `eq | neq | in | not_in | gte | lte | gt | lt | contains | not_contains | is_set | is_not_set`. Filtros aninham com `and`/`or`.
- `date_range` aceita `preset` (`today`, `last_7_days`, `last_30_days`, `this_month`, …) resolvido **no timezone do workspace** (M1), ou `{ "from": ISO, "to": ISO }`.

**Compilação e injeção obrigatória de `workspace_id`.** O compilador **sempre** prepende, no `WHERE`, filtros que o cliente nunca escreve nem consegue remover: `workspace_id`, `is_bot = 0` (regra 11) e a janela de data. Valores viram **parâmetros server-side do ClickHouse** (`{nome:Tipo}`) — nunca interpolação de string — o que elimina injeção. Exemplo compilado do spec acima:

```sql
SELECT
  toStartOfDay(timestamp)                       AS bucket,
  context_utm_source                            AS d_utm_source,
  countIf(event_name = 'purchase')              AS m1,
  sumIf(prop_value, event_name = 'purchase')    AS m2,
  uniqExactIf(user_id, event_name = 'purchase') AS m3
FROM events
WHERE workspace_id = {workspace_id:String}   -- SEMPRE injetado; fora do controle do cliente
  AND is_bot = 0                              -- regra 11 (bots não contam)
  AND timestamp >= {start:DateTime}
  AND timestamp <  {end:DateTime}
  AND context_utm_medium = {p0:String}
  AND prop_value        >= {p1:Float64}
  AND event_name IN     ({p2:Array(String)})
GROUP BY bucket, d_utm_source
ORDER BY m2 DESC
LIMIT {limit:UInt32}
SETTINGS max_execution_time = 20,
         max_rows_to_read   = 2000000000,
         max_memory_usage   = 4000000000,
         max_result_rows    = 50000
```

> ⚠️ **`workspace_id` não é um filtro do usuário — é uma invariante do compilador.** O spec não tem campo para `workspace_id`; se algum vier no JSON, é ignorado. O binding é feito com o `workspace_id` do JWT/sessão (M1), não com nada vindo do corpo da requisição. Este é o ponto onde um bug vira vazamento entre tenants — tratar o compilador como código de segurança, com testes de isolamento obrigatórios (ver "Segurança multi-tenant").

**Tipos de insight suportados** (cada um tem um compilador dedicado sobre o mesmo spec):
- `trends` — série temporal / contagem de eventos por bucket (`toStartOf{Minute,Hour,Day,Week,Month}`), 1..N measures, breakdown opcional por dimensão.
- `funnel` — reusa a semântica do M5 via `windowFunnel()`/`arrayJoin` sobre `steps` (o spec de funnel carrega `steps[]` em vez de `measures`).
- `retention` — matriz de retenção (`cohort` por evento inicial × evento de retorno), `retention()`/`sumMap` no ClickHouse.
- `path` (flow) — sequência de eventos por usuário via `sequenceMatch`/`groupArray` ordenado; top-N caminhos.
- `breakdown` (tabela) — agregação plana por 1..N dimensões, sem eixo temporal — a "planilha" do explorador.

> ⚠️ **`retention` e `path` dependem do identity graph (M8).** Sem `user_id` estável cross-device o resultado subestima retenção e quebra caminhos. Enquanto o stitching do workspace não estiver materializado, esses dois tipos ficam marcados como "parcial" na UI.

---

#### Explorador visual (no-code) — o produto padrão

É o que 95% dos clientes usam. **Zero SQL.** Tudo por dropdown, gerando o `ExplorerQuerySpec` por baixo.

Fluxo:
1. **Escolher o tipo de insight** (trends / funnel / retention / path / breakdown).
2. **Montar measures** — "conte `purchase`", "some `properties.value` de `purchase`", "usuários únicos que fizeram `lead`". Adiciona várias.
3. **Filtrar** — construtor de condições (`utm_medium = paid` E `value ≥ 100`), com autocomplete de valores puxado do catálogo (amostrado).
4. **Quebrar por (breakdown/group_by)** — `utm_source`, `device_type`, `ip_country`, ou qualquer propriedade do catálogo.
5. **Período + granularidade** — date range e day/week/month (timezone do workspace).
6. **Preview em tempo real** — cada mudança dispara `POST /v1/explorer/query` (versão amostrada/limitada, barata) e re-renderiza gráfico + tabela em < 2s.
7. **Salvar como insight** — vira registro em `insights` (spec versionado).
8. **Adicionar ao dashboard** — o insight salvo é referenciado como widget pelo M6 (Dashboard Builder). O dashboard passa a hospedar insights self-serve ao lado dos KPIs nativos.

Saída dupla sempre: **visualização** (line/bar/area/funnel/retention-grid/sankey conforme o tipo) **+ tabela** subjacente exportável (CSV). Drill-down: clicar num ponto abre sheet com os eventos que compõem aquele número (reusa `GET /v1/events/recent` filtrado).

> ⚠️ **A incerteza de reconciliação atravessa o explorador.** Se o `reconciliation_gap` (M14) do período consultado estiver acima do limiar, todo insight que envolva receita/conversão exibe a **marca de incerteza** e um aviso ("dados deste período ainda não reconciliaram com o gateway"). O explorador não pode virar um caminho lateral para mostrar número "confiável" que o resto do produto marcaria como suspeito (regra 12).

---

#### Modo SQL guardado (avançado — planos Agency/Enterprise)

Para o power user (analista da agência, time de dados do cliente Enterprise) que quer expressividade total. O cliente escreve `SELECT`, mas **nunca contra as tabelas físicas nem contra o cluster de ingestão** — só contra **views virtuais já isoladas no workspace dele**, num pool de leitura dedicado, dentro de um sandbox rígido.

**Camada de views virtuais por workspace.** Cada workspace enxerga um _namespace_ lógico com views já filtradas:

```sql
-- provisionado/gerenciado pelo Truvo, nunca pelo cliente:
CREATE VIEW explorer.events AS
  SELECT * FROM events
  WHERE workspace_id = {current_workspace_id}   -- amarrado via ROW POLICY/param de sessão
    AND is_bot = 0;
-- idem: explorer.touchpoints, explorer.sessions, explorer.conversions
```

O cliente escreve `SELECT utm_source, count() FROM events GROUP BY utm_source` e resolve para a **sua** view isolada — ele nunca referencia `workspace_id` e não tem GRANT nas tabelas base.

**Sandbox do ClickHouse (defesa em camadas):**
1. **Usuário read-only dedicado** (`truvo_explorer`) com perfil `readonly = 1` — sem DDL, sem DML, sem `SET` de settings sensíveis, sem acesso a `system.*` (exceto o mínimo), sem `INSERT/ALTER/CREATE/DROP`.
2. **`CREATE ROW POLICY`** por `workspace_id` nas tabelas base — cinta de segurança caso alguma view seja contornada: nenhuma linha de outro workspace é visível ao usuário do explorer.
3. **`CREATE QUOTA`** por workspace/usuário — teto de _tempo de execução, linhas lidas, bytes lidos, memória e linhas de resultado por intervalo_ (ex.: janela de 1h). Estoura a cota → novas queries são recusadas até a janela virar.
4. **Settings por query** (não confiáveis vindas do cliente, aplicadas por nós): `max_execution_time`, `max_rows_to_read`, `max_bytes_to_read`, `max_memory_usage`, `max_result_rows`, `max_result_bytes`, `result_overflow_mode = 'break'`, `timeout_overflow_mode = 'throw'`.
5. **Allowlist sintático (AST) antes de tocar o ClickHouse** — o SQL é parseado (dialeto ClickHouse) no `POST /v1/explorer/sql/validate`; só passa se: for **um único `SELECT`** (ou `WITH … SELECT`); **sem** `INSERT/ALTER/CREATE/DROP/RENAME/ATTACH/DETACH/OPTIMIZE/SYSTEM/SET/GRANT`; **sem** funções perigosas — `system()`, `file()`, `url()`, `remote()`, `remoteSecure()`, `s3()`, `hdfs()`, `mysql()`, `postgresql()`, `jdbc()`, `dictGet*` arbitrário, `executable()`, `input()`; **sem** referência a bancos/tabelas fora do namespace `explorer.*` do workspace. Falha na validação → `422` com o motivo.
6. **Pool de leitura dedicado** — as queries do explorer rodam numa **réplica/pool de leitura separado** do caminho de ingestão. Uma query pesada do cliente **nunca** pode degradar a escrita de eventos nem os dashboards nativos.

Ordem de execução: `validate (AST) → aplicar settings/quota → executar como truvo_explorer com ROW POLICY → paginar/streamar resultado`.

> ⚠️ **SQL cru é a maior superfície de risco do produto inteiro.** Dois modos de falha: **(a) vazamento entre tenants** — uma view mal provisionada, um GRANT largo demais ou um bypass da row policy expõe dados de outro cliente; **(b) DoS no cluster** — uma query cartesiana derruba memória/CPU compartilhados. Mitigação inegociável: **nunca** executar SQL do cliente no cluster de ingestão; sempre no pool isolado; sempre com ROW POLICY + views por workspace + quota + limites por query; e **testes de isolamento automatizados** que tentam ativamente ler outro `workspace_id` e falham o build se conseguirem.

> ⚠️ **Gate de plano e de role.** O modo SQL é feature `explorer_sql`, liberada só em **Agency/Enterprise** (M11) e só para roles `owner`/`admin` (M1) — `member`/`viewer` ficam no explorador visual. Toda execução de SQL é registrada em `explorer_query_log` (quem, quando, SQL, custo real) para auditoria.

---

#### Insights salvos, versionamento e compartilhamento

- **CRUD de insights** (`insights`) — cada insight salva `kind` (`visual` | `sql`), `insight_type`, o `spec` JSONB (ou o SQL guardado), dono, nome e descrição. Um insight visual e um insight SQL convivem na mesma biblioteca.
- **Versionamento** (`insight_versions`) — toda alteração cria uma versão imutável (spec/SQL + autor + timestamp). Permite `restore` para uma versão anterior e diff entre versões. Dá segurança para o cliente iterar sem medo.
- **Executar salvo** — `POST /v1/insights/:id/run` roda o insight com os limites do plano e devolve dados + metadados de custo + marca de incerteza (se aplicável).
- **Compartilhamento read-only** (`insight_shares`) — gera token público (com ou sem senha, com expiração opcional) que renderiza o insight sem auth e **sem** permitir editar o spec/SQL nem trocar de workspace. O token carrega apenas o `insight_id`; o `workspace_id` é resolvido server-side a partir do dono — nunca do request.
- **Dashboards self-serve** — insights salvos são os blocos que o cliente arrasta no Dashboard Builder (M6). O explorador é onde ele _cria_; o dashboard é onde ele _organiza_.

---

#### Catálogo de schema (dimensões e métricas disponíveis)

O explorador só é usável se o cliente souber **o que dá pra medir e quebrar**. O catálogo é a fonte disso e o **allowlist** que o compilador consulta.

- **Campos de topo e `context.*`** — derivados do EventSchema (seção 4): `event_name`, `source`, `session_id`, `user_id`, `anonymous_id`, `order_id`, `context.utm_*`, `context.device_type`, `context.os`, `context.browser`, `context.ip_country`, `context.ip_city`. Fixos e tipados.
- **`properties.*` dinâmicas** — descobertas por **amostragem** do ClickHouse por workspace (top chaves + tipo inferido + valores frequentes para autocomplete), cacheadas em `explorer_catalog` e refrescadas periodicamente.
- **Métricas nativas reusadas** — ROAS, CAC, AOV, CVR etc. (M6) aparecem como measures pré-definidas quando o workspace tem os dados (spend via M10, receita via M4).
- **Custom por workspace** — o cliente pode nomear/alias-ar dimensões e salvar measures reutilizáveis, versionadas em `explorer_catalog`.

> ⚠️ **PII nunca entra no catálogo em claro.** `email` só existe como `email_hash` (regra 4); `ip` bruto não existe — só `ip_country`/`ip_city` (regra 5). O catálogo não expõe, e o compilador não aceita, qualquer campo de PII em texto puro. Nada no explorador (visual ou SQL) pode reconstruir e-mail ou IP.

---

#### Feature gates por plano

| Recurso | Starter | Growth | Agency | Enterprise |
|---|:---:|:---:|:---:|:---:|
| Explorador visual (no-code) | ✅ (limitado) | ✅ | ✅ | ✅ |
| Insights salvos | 5 | ilimitado | ilimitado | ilimitado |
| Retention / Path (M8) | ❌ | ✅ | ✅ | ✅ |
| **Modo SQL guardado** | ❌ | ❌ | ✅ | ✅ |
| Cota de compute (linhas lidas/mês) | baixa | média | alta | dedicada |

---

#### Endpoints

```
# Execução — modelo visual (spec JSON)
POST   /v1/explorer/query                 (executa ExplorerQuerySpec; auth JWT)
POST   /v1/explorer/query/preview         (execução amostrada/limitada p/ preview barato)

# Execução — SQL guardado (Agency/Enterprise, role admin+)
POST   /v1/explorer/sql/validate          (parseia/allowlist; retorna custo estimado; NÃO executa)
POST   /v1/explorer/sql                    (executa no sandbox read-only isolado)

# Catálogo do schema (dimensões / métricas / propriedades)
GET    /v1/explorer/catalog                (campos, dimensões e measures disponíveis)
GET    /v1/explorer/catalog/properties?event=purchase   (propriedades amostradas de um evento)
GET    /v1/explorer/catalog/values?field=context.utm_source   (autocomplete de valores)

# Insights salvos (CRUD + versionamento + compartilhamento)
GET    /v1/insights
POST   /v1/insights
GET    /v1/insights/:id
PATCH  /v1/insights/:id
DELETE /v1/insights/:id
POST   /v1/insights/:id/run               (roda o insight salvo e retorna dados)
GET    /v1/insights/:id/versions
POST   /v1/insights/:id/restore/:versionId
POST   /v1/insights/:id/share             (cria token read-only)
DELETE /v1/insights/:id/share/:shareId
GET    /v1/insights/public/:token         (público, read-only, sem auth)
```

> ⚠️ **Toda query é assíncrona-tolerante e nunca "meio-verdadeira".** Se uma execução estoura `max_execution_time`/cota/`max_result_rows`, a resposta retorna `status: "aborted"` com o motivo (timeout, quota_exceeded, result_truncated) — **nunca** um resultado parcial disfarçado de completo. Coerente com a tese do produto: sinalizar incerteza em vez de mentir (regra 12).

---

### MÓDULO 17 — AI JOURNEY INTELLIGENCE *(novo na v3.2)*

#### Por que existe
O cliente já tem funil (M5), atribuição (M7), criativos (M10) e dado reconciliado (M14). O que ele **não** tem é tempo nem repertório analítico para cruzar tudo isso e responder a pergunta que importa: *"quais rotas de conversão, por canal, me levam melhor ao meu objetivo — e o que eu faço com isso?"*. Hoje isso é trabalho manual de analista sênior olhando cinco telas.

Este módulo é o **copilot de analytics** do Truvo — na linha do Amplitude Ask e do Mixpanel Spark — mas com uma diferença que é o produto inteiro: **os copilots do mercado deixam o LLM inventar número; o nosso não deixa**. Aqui o LLM **nunca calcula nem estima**. Primeiro o Truvo computa tudo de forma **determinística no ClickHouse**, já **reconciliado com o gateway** (M14); só depois o Claude recebe **apenas os agregados prontos** e gera narrativa, ranking e recomendações. É a tagline do produto ("Dados que você pode confiar") aplicada à camada de IA: preferimos sinalizar incerteza a mentir com fluência.

> ⚠️ **A regra de ouro deste módulo:** o LLM é um **redator e priorizador**, não uma calculadora. Se um número não veio do cálculo determinístico, ele **não pode aparecer** na resposta. Sem isso, este módulo vira gerador de alucinação convincente — o oposto da tese do Truvo.

#### Arquitetura em duas fases (deterministic-first) — o cerne da confiança
Toda análise passa por duas etapas estritamente separadas. A fronteira entre elas é a garantia anti-alucinação.

**Fase 1 — Cálculo determinístico (ClickHouse, sem IA)**
Roda sobre `touchpoints` e `events`, sempre com `workspace_id` fixo e `is_bot = 0`. Produz um **pacote de agregados** (o "evidence pack") que é a única fonte de números do módulo:
- **Path analysis:** reconstrução da sequência ordenada de canais por usuário convertido (rota / "journey signature", ex.: `instagram/paid > google/organic > direct`).
- **Taxa de conversão por rota e por canal de entrada**, com **limite de volume mínimo** e **Wilson lower-bound** para não rankear sorte de amostra pequena.
- **Receita atribuída por rota** vinda do M7 (modelo de atribuição escolhido no objetivo), **já reconciliada** com o gateway (M14).
- **CAC / ROAS / LTV / time-to-convert por rota**, cruzando spend do M10 quando disponível.
- **Flag de reconciliação do período** (do `reconciliation_daily` do M14): `reconciled` | `uncertain`.

```sql
-- Fase 1 (ilustrativo): melhores rotas por canal de entrada, sem bot, um único workspace
WITH conv AS (
  SELECT user_id, min(timestamp) AS conv_ts
  FROM events
  WHERE workspace_id = {ws:String}
    AND is_bot = 0
    AND event_name = 'purchase'
    AND timestamp BETWEEN {start:DateTime} AND {end:DateTime}
  GROUP BY user_id
)
SELECT
  tp.entry_channel                                   AS entry_channel,
  arrayStringConcat(tp.channel_path, ' > ')          AS journey,
  uniqExact(tp.user_id)                              AS converters,
  round(sum(tp.attributed_revenue), 2)               AS revenue_reconciled,   -- M7 + M14
  round(sum(tp.attributed_revenue) / nullIf(sum(tp.spend),0), 2) AS roas,
  round(sum(tp.spend) / nullIf(uniqExact(tp.user_id),0), 2)      AS cac,
  -- gate de significância: só entra no ranking com volume mínimo
  wilsonLowerBound(converters, starters)             AS cvr_lb
FROM touchpoints tp
WHERE tp.workspace_id = {ws:String} AND tp.is_bot = 0
  AND tp.attribution_model = {model:String}
GROUP BY entry_channel, journey
HAVING converters >= {min_sample:UInt32}
ORDER BY entry_channel, cvr_lb DESC
```

**Fase 2 — Geração de insight (Claude, via API Anthropic)**
O evidence pack (JSON de agregados anônimos) é enviado ao LLM. Recomendamos **Claude Opus 4.8** para a análise principal (ranking + recomendações) e **Claude Sonnet 5** para o modo pergunta-resposta interativo (custo/latência menores). O prompt de sistema fixa os guardrails:

```jsonc
// Contrato do prompt (system) — o que o LLM PODE e NÃO PODE fazer
{
  "role": "Você é o analista do Truvo. NÃO calcule nem estime números.",
  "regras": [
    "Cite APENAS números presentes em `evidence`. Número ausente = proibido.",
    "Se `evidence.reconciliation == 'uncertain'`, prefixe toda afirmação com aviso de incerteza e NÃO trate número como fato.",
    "Se `evidence.sample` < mínimo, diga que não há volume para conclusão.",
    "Toda afirmação deve referenciar o `evidence_ref` que a sustenta.",
    "Responda no idioma do workspace. Sem PII (não há PII no contexto)."
  ],
  "evidence": { /* SÓ agregados: rótulos de canal, contagens, taxas, receita reconciliada, refs de query */ }
}
```

> ⚠️ **Isolamento absoluto:** o `evidence` de um workspace **nunca** contém dado de outro tenant. Não há "benchmark cross-tenant" no contexto do modelo (regra 1). O que vai ao Claude é sempre de um único `workspace_id`.

#### Definição de OBJETIVO pelo cliente
O cliente não pergunta "o que é bom?" — ele declara **o que quer otimizar**. Um objetivo é a tupla:
- **Métrica-alvo:** `maximize_roas` · `minimize_cac` · `maximize_ltv` · `maximize_cvr` · `maximize_revenue`.
- **Janela:** período de análise (ex.: últimos 30/90 dias) + `attribution_window` e modelo de atribuição (herda M7).
- **Segmento:** filtro opcional (utm_source/medium/campaign, device_type, ip_country, produto/oferta) — o mesmo vocabulário do M6/M16.

O objetivo vira a **função de ranking** da Fase 1: para `minimize_cac`, ordena rotas por CAC crescente (com gate de volume); para `maximize_roas`, por ROAS reconciliado; e assim por diante. O LLM **não escolhe** a ordenação — ele **narra** a ordenação que o cálculo produziu.

#### Saídas
**1. Ranking das melhores jornadas de conversão por canal**
Para o objetivo escolhido, a lista das rotas de maior desempenho **por canal de entrada** (Instagram, Google, Direct, Email...), com: rota, conversões, CVR (com lower-bound), receita reconciliada, ROAS/CAC/LTV, e `objective_score` normalizado. Só entram rotas acima do volume mínimo.

**2. Insights em linguagem natural**
Narrativa ancorada nos agregados, sempre com o número exato do cálculo:
> "Usuários vindos de **Instagram/paid** que passam por **retargeting no Google** convertem **2,3x mais** (CVR 6,1% vs 2,6% da média) e têm **CAC 40% menor** (R$ 38 vs R$ 63). Baseado em **412 conversões reconciliadas** nos últimos 90 dias."

**3. Recomendações acionáveis atadas ao objetivo**
Cada recomendação amarra uma ação a um número e a um impacto projetado (calculado deterministicamente, não pelo LLM):
> "Para **minimizar CAC**: realocar budget para a rota Instagram→Google-retargeting. Projeção: −R$ 25/conversão mantendo volume atual." Recomendações têm ciclo de vida (`new → accepted → done → dismissed`).

**4. Detecção de oportunidades / anomalias**
A Fase 1 sinaliza rotas com desvio estatístico (queda/salto de CVR, ROAS fora do esperado, rota emergente com volume subindo). O LLM apenas descreve; alertas relevantes são roteados pelo **M12**.

#### Modo pergunta-resposta (text-to-query via M16)
Opcional, para perguntas ad-hoc ("qual canal traz o cliente de maior LTV nos últimos 60 dias?"). O fluxo **não gera SQL cru**: o Claude traduz a pergunta para o **modelo de query do Truvo** (o mesmo do Data Explorer — M16), que valida, força `workspace_id`, executa no ClickHouse e devolve os números; só então o LLM redige a resposta sobre o resultado. Isso mantém o isolamento multi-tenant e a auditabilidade, e reaproveita todo o guardrail de segurança do M16 (sanitização, escopo de workspace, sem SQL injection).

> ⚠️ Text-to-query pode interpretar mal a intenção. A resposta **sempre** mostra a query traduzida e os números — o cliente vê o que foi perguntado ao dado antes de confiar na frase.

#### Explicabilidade (ligação com M16)
Toda afirmação da IA — insight, item de ranking ou recomendação — carrega um **evidence_ref**: a query determinística e os números-base que a originaram, abertos em um painel "ver dado" que leva ao Data Explorer (M16). Nenhuma frase é órfã. Se o cliente não consegue auditar, o número não sai.

#### Notas honestas
> ⚠️ **Volume mínimo para significância:** rotas com poucas conversões não geram conclusão — o módulo diz "sem dados suficientes" em vez de inventar tendência. O limiar é configurável por workspace (default sugerido: ≥ 30 conversões por rota + Wilson lower-bound).
>
> ⚠️ **Nunca apresentar número não-reconciliado como fato:** se o `reconciliation_gap` do período estiver acima do limiar (M14, regra 12), toda a saída de IA entra em **modo incerteza** — números marcados como estimativa provisória, recomendações suspensas de "aplicar automaticamente".
>
> ⚠️ **Privacidade:** o prompt do LLM **jamais** recebe PII. Sem email, sem `email_hash`, sem `user_id` bruto, sem IP — apenas rótulos de canal e agregados. Nenhum dado pessoal, de nenhum titular, chega ao provedor do modelo (regra 4/5 + nova regra 16). Exige **DPA + zero data retention** contratados com a Anthropic.
>
> ⚠️ **Custo:** IA generativa custa por token e é feature de plano alto (Agency/Enterprise). O cálculo determinístico é barato e roda sempre; a chamada ao Claude é gated e com orçamento de tokens por workspace.

#### Referência de padrão
Amplitude Ask, Mixpanel Spark, PostHog Max — copilots que traduzem pergunta em análise. O diferencial do Truvo: os concorrentes ancoram no dado bruto da própria plataforma (que pode estar over-attributed); **o nosso ancora em dado reconciliado com o caixa** (M14). Mesma UX, base de verdade diferente.

#### Endpoints
```
POST   /v1/ai/objectives                 (cria objetivo: métrica-alvo + janela + segmento)
GET    /v1/ai/objectives
GET    /v1/ai/objectives/:id
PATCH  /v1/ai/objectives/:id
DELETE /v1/ai/objectives/:id

POST   /v1/ai/journeys/analyze           (roda análise por objetivo → run assíncrono)
GET    /v1/ai/journeys/runs/:runId       (status + resultado: ranking, insights, flag reconciliação)
GET    /v1/ai/journeys/best?objective_id=&channel=&model=&start=&end=
                                          (melhores jornadas de conversão por canal)

POST   /v1/ai/ask                        (pergunta em linguagem natural → text-to-query M16)
GET    /v1/ai/conversations              (histórico de perguntas + query gerada + evidência)

GET    /v1/ai/recommendations?objective_id=&status=
POST   /v1/ai/recommendations            (salvar recomendação gerada)
PATCH  /v1/ai/recommendations/:id        (status: accepted | done | dismissed)

GET    /v1/ai/insights/:id/evidence      (explicabilidade: query base + números — liga ao M16)
```

> ⚠️ `POST /v1/ai/journeys/analyze` é **assíncrono** (Fase 1 pesada no ClickHouse + latência do LLM na Fase 2): retorna `run_id` e o cliente faz polling em `/runs/:runId`, no mesmo padrão dos relatórios (M13). O resultado é cacheado por período/objetivo para não re-gastar tokens à toa.

---

### FRONTEIRAS & DECISÕES PENDENTES (M15 / M16 / M17) *(novo na v3.2)*

Consolidação da reconciliação entre os três módulos analíticos novos e os existentes. **Ler antes de implementar M15/M16/M17.**

#### Matriz de propriedade (fonte de verdade única por capacidade)
- **Identity graph / merges / unmerge / stitching** → **M8**. M15 só lê (e, no máximo, dispara ação de merge que o M8 executa).
- **Touchpoints + crédito de atribuição** → **M7**. M15 e M17 apenas consomem.
- **Funil nomeado/configurado + drop-off** → **M5**.
- **Motor de query / camada semântica / catálogo / sandbox** → **M16**.
- **Flag de reconciliação (`reconciliation_daily`)** → **M14**.
- **KPIs nativos + Dashboard Builder** → **M6**.
- **Perfil individual (pessoa)** → **M15** (superfície de leitura).
- **Narração/ranking/recomendação/objetivo (IA)** → **M17** (não computa número próprio; orquestra M7+M14+M16+M10 e o Claude).

#### Cadeia de chamadas
- **M15** consome M8 (grafo) + M2 (eventos) + M7 (jornada) + M14 (incerteza) + M1 (roles/PII). Escreve a projeção `user_profiles` — recomputada **pelo worker de stitching do M8**, não pelo M15.
- **M16** estende M6 (insights viram widgets) + consome M2, M1, M14, M8 (retention/path), M11 (gate). Fornece a M17 o modelo de query para text-to-query.
- **M17** consome M7 + M14 + M16 + M10 (spend, opcional) + M12 (anomalia→alerta) + M11 (gate). É consumidor final — **não computa nada sozinho**.

#### Duplicações a RESOLVER (decisão pendente)
1. **PATH/JORNADA aparece em 4 lugares** — fronteira a fixar: **M7** = conversion paths + crédito (fonte); **M15** = touchpoints do M7 renderizados para 1 pessoa (não recalcula crédito); **M16 `path`** = lente exploratória sobre *qualquer* evento (`sequenceMatch`), ad-hoc; **M17** = rotas por canal rankeadas por objetivo. **Decidir:** a Fase 1 do M17 deve **reusar os compiladores `path/breakdown` do M16** (recomendado), não rodar SQL bespoke.
2. **FUNNEL duplicado** — M16 tem insight `funnel` que "reusa a semântica do M5". Decidir: M16 `funnel` **chama a primitiva de cálculo do M5** (M5 segue dono do funil de registro); funnel salvo no explorer **não** vira funil M5.
3. **CUSTOM METRIC duplicado** — M6 (numerator/denominator) vs M16 (`measures`). Convergir: o KPI do M6 vira caso particular de measure do M16, compartilhando a camada semântica — senão o cliente cria a mesma métrica em dois lugares com resultados divergentes.
4. **DRILL-DOWN de eventos** — M6/M15/M16 abrem "sheet de eventos". `GET /v1/events/recent` é "últimos 50", insuficiente. **Criar um endpoint único de listagem de eventos com filtros + cursor** (em M2) e todos os três consomem.

#### Coerência com regras — 2 lacunas reais a decidir
- **Mapeamento da reconciliação:** `reconciliation_daily` é por dia/workspace, mas M15 marca LTV de *pessoa*, M16 marca insight de *período arbitrário*, M17 marca *rota/segmento*. **Falta a regra de como propagar um gap dia-level para incerteza em sub-período/rota/perfil** (senão cada módulo improvisa diferente).
- **`properties.*` com PII injetada pelo cliente** (M16): a amostragem do catálogo pode expor `properties.email` em claro. Exige **detecção/blocklist de PII** na amostragem (ver seção 11).

#### Ordem recomendada dos três
**M15 e M16 em paralelo após M7 (~Fase 9)** → **M17 por último (~Fase 11)**. M16 precede M17 (M17 usa o modelo de query). Sub-fases: adiantar Identidades+Timeline do M15 logo após M8 (Fase ~4.5); no M16, **visual primeiro**, SQL só depois do pool de leitura + row policy + quota + harness de teste de isolamento; no M17, Fase 1 (determinística) validada antes de plugar a Fase 2 (Claude).

#### Decisões pendentes (backlog para o dono do produto)
1. Schema de `touchpoints` (M7): a Fase 1 do M17 assume `entry_channel`, `channel_path[]`, `attributed_revenue`, `spend`, `is_bot`, `attribution_model` — alinhar; e definir se `attributed_revenue` já vem reconciliado (M14) e se touchpoints carregam `is_bot`.
2. Mapeamento reconciliação dia-level → incerteza de perfil/rota/insight (a lacuna mais importante).
3. Onde vive o **cálculo de impacto projetado** do M17 ("−R$25/conversão") — nenhum módulo é dono; definir premissas ou remover.
4. Detecção/blocklist de PII em `properties.*` (M16).
5. Endpoint único de listagem de eventos filtrado+cursor (M2) para todos os drill-downs.
6. Unificar a infra de **share token público** (M6 dashboards + M13 reports + M16 insights) numa só.
7. Numeração final das regras (já conciliada nesta v3.2: M17 = 14–18; M16 = 19; M15 = 20).
8. Gate de plano do M15 (User 360) — proposto: Growth+ (`user_360`).
9. Serviço único de job/polling assíncrono (M13 relatórios + M16 queries pesadas + M17 runs).
10. `explorer.conversions`/`explorer.sessions` (M16) → mapear para `events where event_name='purchase'` e `sessions_mv`, ou criar as views.
11. Lib única de normalização+hash de PII em `packages/event-schema` — a busca do M15 só acha o usuário se usar exatamente a mesma normalização da ingestão.
12. Enforcement de custo: cota de compute (M16) + orçamento de tokens (M17) ligados ao metering do M11 (Usage Records).

---

## 8. BANCO DE DADOS

### PostgreSQL (Supabase) — tabelas principais
```
users                 → usuários da plataforma
workspaces            → workspaces multi-tenant
workspace_members     → membros e roles (RLS pivot)
api_keys              → chaves de API (hash SHA-256)
tracking_links        → links rastreados com UTMs
funnels               → funis com steps em JSONB
dashboards            → dashboards com layout em JSONB
kpi_definitions       → KPIs customizados
integrations          → configurações de integração
webhook_logs          → logs de webhooks recebidos
identity_links        → identity graph
identity_merges       → histórico de merges
consent_records       → consentimento de tracking por usuário/visitante  (novo)
notifications         → notificações in-app                              (novo)
alert_rules           → regras de alerta por workspace                   (novo)
reports               → relatórios e agendamentos                        (novo)
subscriptions         → assinaturas Stripe por workspace                 (novo)
user_profiles         → projeção consolidada do perfil (cache) — M15     (novo v3.2)
profile_access_log    → auditoria LGPD de acesso a perfil — M15          (novo v3.2)
insights              → insights salvos self-serve (visual|sql) — M16    (novo v3.2)
insight_versions      → versões imutáveis de cada insight — M16          (novo v3.2)
insight_shares        → tokens read-only de compartilhamento — M16       (novo v3.2)
explorer_catalog      → catálogo semântico/allowlist por workspace — M16 (novo v3.2)
ai_objectives         → objetivos de otimização (ROAS/CAC/LTV…) — M17     (novo v3.2)
ai_journey_runs       → execuções de análise (evidence pack) — M17       (novo v3.2)
ai_insights           → afirmações da IA com evidence_ref — M17          (novo v3.2)
ai_recommendations    → recomendações acionáveis por objetivo — M17      (novo v3.2)
ai_conversations      → histórico do modo pergunta-resposta — M17        (novo v3.2)
```

### ClickHouse — tabelas principais
```
events                → todos os eventos (ReplacingMergeTree)
sessions_mv           → sessões materializadas (AggregatingMergeTree)
daily_stats_mv        → conversões diárias pré-agregadas (SummingMergeTree)
touchpoints           → touchpoints por conversão para attribution
reconciliation_daily  → totais Truvo vs gateway por dia                  (novo)
explorer_query_log    → auditoria/telemetria de query (visual+SQL) — M16 (novo v3.2)
journey_paths_daily   → caminhos de conversão agregados por dia — M17    (novo v3.2)
```

### Infra de query self-serve (M16) *(novo na v3.2)*
- **Pool/réplica de leitura ClickHouse dedicado**, separado do caminho de ingestão — queries
  self-serve pesadas nunca degradam a escrita de eventos nem os dashboards nativos.
- **Views `explorer.*` por workspace**, usuário `truvo_explorer` (`readonly=1`),
  `CREATE ROW POLICY` e `CREATE QUOTA` por `workspace_id`, e limites por query
  (`max_execution_time` / `max_rows_to_read` / `max_memory_usage` / `max_result_rows`).

### Isolamento multi-tenant
- Toda tabela PostgreSQL tem `workspace_id`; RLS habilitada em todas.
- Toda query ao ClickHouse filtra por `workspace_id`.
- API keys com escopo de workspace.

---

## 9. REGRAS DE NEGÓCIO — NUNCA VIOLAR

1. **Toda query filtra por `workspace_id`** — isolamento multi-tenant.
2. **Dedup por `order_id`:** prioridade webhook > api > gateway > redirect > pixel > url.
3. **`SUPABASE_SERVICE_ROLE_KEY` nunca vai para o frontend.**
4. **Emails armazenados como SHA-256 hash**, nunca plain text.
5. **IPs anonimizados** — armazenar apenas country + city (descartar IP após enrich).
6. **Webhooks verificam HMAC-SHA256** antes de qualquer processamento.
7. **API keys armazenadas como hash SHA-256**, nunca plain text.
8. **Rate limiting por workspace** via Redis antes de processar evento.
9. **`POST /v1/events` retorna 200 imediatamente** — processamento assíncrono via Kafka.
10. **Server-side tracking tem prioridade** sobre client-side em attribution e dedup.
11. **Eventos de bot nunca contam** para funis, KPIs, attribution ou billing *(novo)*.
12. **Nenhum dado analítico é "confiável"** enquanto o `reconciliation_gap` daquele período
    estiver acima do limiar — o produto sinaliza incerteza em vez de mentir *(novo)*.
13. **Sem consentimento não há PII:** o pixel não seta cookie nem envia dados pessoais
    quando o consentimento for negado *(novo)*.
14. **IA nunca inventa número (M17):** o LLM só cita métricas presentes no *evidence pack*
    determinístico calculado no ClickHouse; número ausente do contexto é proibido — sem
    estimativa, extrapolação ou cálculo pelo modelo *(novo v3.2)*.
15. **IA ancorada em dado reconciliado (M17):** se o `reconciliation_gap` do período estiver
    acima do limiar (M14), toda saída de IA entra em modo incerteza e não apresenta número
    como fato — extensão direta da regra 12 *(novo v3.2)*.
16. **Nunca enviar PII ao modelo (M17):** email, `email_hash`, `user_id` bruto, IP e qualquer
    dado pessoal jamais entram no prompt do LLM — só rótulos de canal e agregados anônimos,
    sempre de um único `workspace_id` (nunca cross-tenant) *(novo v3.2)*.
17. **Toda afirmação da IA é auditável (M17):** cada insight/ranking/recomendação carrega um
    `evidence_ref` (query determinística + números-base) abrível no Data Explorer; frase sem
    evidência não é exibida *(novo v3.2)*.
18. **Text-to-query nunca gera SQL cru (M17):** perguntas em linguagem natural são traduzidas
    para o modelo de query do Truvo (M16), que força `workspace_id` e sanitiza antes de tocar
    o ClickHouse *(novo v3.2)*.
19. **Isolamento do motor de query (M16):** o compilador SEMPRE injeta `workspace_id`, `is_bot=0`
    e a janela de data (o cliente não os remove; `workspace_id` vem do JWT). SQL guardado só roda
    em pool de leitura isolado, com usuário read-only, ROW POLICY e QUOTA por workspace e testes
    de isolamento entre tenants no build — nunca no cluster de ingestão *(novo v3.2)*.
20. **Customer 360 (M15):** identidades nunca cruzam workspaces; todo acesso a um perfil
    individual é auditado em `profile_access_log`; e-mail/telefone só como hash, IP nunca
    exibido *(novo v3.2)*.

---

## 10. VALIDAÇÃO & QUALIDADE DE DADOS *(novo na v3.0)*

O produto vende confiança. Portanto, **"o número está certo?" é uma feature de primeira
classe**, não um detalhe operacional.

### Ground truth
A fonte de verdade da receita é o **gateway** (Shopify/Stripe/Hotmart/Kiwify), não o Truvo
nem a plataforma de ads. O Truvo deve sempre poder responder: *"a receita que eu mostro bate
com a receita que caiu no caixa?"*

### Metodologia de reconciliação (M14)
1. Diariamente, somar receita e conversões do Truvo por workspace.
2. Puxar o total real do gateway no mesmo período.
3. Calcular `reconciliation_gap`. Meta: < 2%.
4. Gap acima do limiar → alerta + marca de incerteza no dashboard.

### O delta honesto
"Mais conversões que o Meta" só é diferencial se for **verdade reconciliada**. Um delta
positivo por over-attribution é defeito. Regra: **primeiro reconciliar com o gateway,
depois comparar com a plataforma.** O delta legítimo é: *conversões reconciliadas que o Meta
não atribuiu* — não *conversões a mais que ninguém consegue explicar*.

### Bot filtering
Eventos de bot distorcem métrica e inflam billing. Filtrados na ingestão, marcados `is_bot`,
excluídos de tudo que é analítico e de cobrança (regra 11).

---

## 11. PRIVACIDADE & COMPLIANCE (LGPD/GDPR) *(expandido na v3.0)*

### Gestão de consentimento *(novo)*
- **Consent manager** integrado ao pixel: sem consentimento, não há cookie nem envio de PII.
- Registro de consentimento em `consent_records` (quem, quando, escopo, versão do texto).
- Modo "cookieless" de fallback: quando o consentimento é negado, capturar apenas eventos
  agregados/anônimos permitidos por lei.

### Dados pessoais
- **Emails:** apenas SHA-256 (lowercase+trim), nunca plain text.
- **IPs:** anonimizados — apenas country + city; IP bruto descartado após enrich.
- **Cookies:** first-party apenas, SameSite=Lax.

### Direitos do titular
- **Exclusão:** `DELETE /v1/users/:id` remove todos os eventos do titular.
  ⚠️ Em ClickHouse (`ReplacingMergeTree`), exclusão é **assíncrona e não-trivial** — usar
  `ALTER TABLE ... DELETE` (mutation) com fila e confirmação; nunca assumir exclusão imediata.
- **Portabilidade:** `GET /v1/users/:id/events` exporta os dados do titular.
- **Retenção:** configurável por workspace (padrão 24 meses); expurgo automático.

### Envio de PII a terceiros (Meta/Google/TikTok) *(novo)*
- Enviar `email_hash` a plataformas de ads é tratamento de PII: exige **base legal +
  consentimento** capturado. Sem consentimento válido, o evento não vai para CAPI/Google/TikTok.

### Contratos *(novo)*
- **DPA (Data Processing Agreement)** e lista de **subprocessadores** disponíveis para o
  cliente — bloqueador de venda B2B para agências. Truvo é operador; o cliente é controlador.
- **Subprocessadores** incluem: Supabase (DB/Auth), Railway (infra), Vercel (frontend/CDN),
  provedor de email (Resend/Postmark), Ads platforms (envio de conversão consentido) e
  **Anthropic** (IA do M17) — este último obrigatoriamente sob **DPA + zero data retention**
  (nenhum dado de cliente retido ou usado para treino).

### IA & privacidade (M17) *(novo na v3.2)*
- O prompt do LLM **jamais** recebe PII — apenas rótulos de canal e agregados anônimos, sempre
  de um único `workspace_id` (nunca cross-tenant). Base legal do envio: dado agregado/anonimizado.

### Trilhas de auditoria *(novo na v3.2)*
- `profile_access_log` (M15) — todo acesso a um perfil individual (quem, quando, o quê).
- `explorer_query_log` (M16) — toda execução de query/SQL self-serve (custo, status).

### Propriedades dinâmicas com PII (M16) *(novo na v3.2)*
- ⚠️ `properties.*` são definidas pelo cliente e podem conter PII em texto puro (ex.:
  `properties.email`). A amostragem do catálogo do Data Explorer deve rodar **detecção/blocklist
  de PII** — o catálogo e o compilador nunca expõem campo pessoal em claro (reforça regras 4/5).

---

## 12. REQUISITOS NÃO FUNCIONAIS

### Performance
- `POST /v1/events`: < 200ms (p99).
- Queries de dashboard: < 2s para 90 dias.
- Pixel JS: < 5kb minificado + gzip.
- `GET /c/:code` (redirect): < 100ms.
- Demais endpoints REST: < 500ms (p95), exceto queries analíticas.

### Segurança
- HTTPS em tudo (TLS 1.3).
- Rate limiting por IP e por API key.
- CORS: apenas origens autorizadas.
- Inputs sanitizados antes de queries ClickHouse.
- Credenciais de integração criptografadas (AES-256).
- Webhook signature verification obrigatória.

### Disponibilidade
- MVP: 99.5% uptime. V1+: 99.9% com alertas automáticos.
- Health check: `GET /health` e `GET /health/ready`.

---

## 13. OBSERVABILIDADE & OPERAÇÃO *(novo na v3.0)*

Um produto de dados falha silenciosamente. Sem observabilidade, o cliente descobre o problema
antes de você — inaceitável para uma ferramenta que vende confiança.

### O que monitorar
- **Data freshness:** atraso entre `received_at` e disponibilidade no dashboard.
- **Consumer lag:** tamanho da fila Kafka / atraso do consumer (alertar acima de limiar).
- **Taxa de dedup e descarte:** picos indicam problema de fonte ou loop.
- **`reconciliation_gap` por workspace:** o KPI de saúde do dado (M14).
- **Erros de webhook e de integrações out** (CAPI/Google/TikTok match quality).
- **Latência dos endpoints** vs SLOs da seção 12.
- **Custo/tokens de LLM por workspace** (M17) — orçamento de tokens e alerta de excedente.
- **Custo real e cota de query self-serve** (M16) — linhas/bytes lidos, memória, queries `aborted`.
- **Staleness da projeção `user_profiles`** (M15) — atraso do recompute após stitching retroativo.

### Ferramentas
- Logs estruturados (JSON) + tracing (OpenTelemetry).
- Métricas/dashboards de operação (Grafana ou equivalente do Railway).
- Alertas de infra roteados pelo M12.

### Health checks
- `GET /health` (liveness) e `GET /health/ready` (readiness: DB, ClickHouse, Kafka, Redis).

---

## 14. FLUXO COMPLETO DE DADOS

Exemplo: compra via Facebook Ads → Shopify.

```
1. Usuário clica no anúncio
   → fbclid capturado da URL pelo tracking link do Truvo
   → click_id gerado: clk_abc → cookie first-party

2. Usuário navega na landing page
   → Pixel JS carrega → anonymous_id: anon_111
   → page_view enviado com click_id + UTMs + anonymous_id

3. Usuário clica em "Comprar" → button_click

4. Usuário preenche checkout
   → checkout_started → email capturado → identify()
   → anonymous_id ligado ao email_hash

5. Shopify confirma pagamento
   → Webhook orders/paid → POST /v1/webhooks/shopify (HMAC verificado)
   → purchase: order_id, value, email_hash
   → email_hash → identity graph → user_id → click_id recuperado → touchpoints

6. Deduplication Engine
   → Pixel enviou checkout_completed (fonte: pixel)
   → Webhook enviou purchase (fonte: webhook)
   → Mesmo order_id → webhook vence → pixel descartado

7. Attribution Engine
   → Touchpoints: facebook_paid (clique) → facebook_paid (remarketing)
   → Last click: 100% facebook_paid · Linear: 50% + 50%

8. ClickHouse → evento armazenado, funil atualizado, touchpoints registrados

9. Reconciliação (M14) → soma do dia bate com receita do Shopify? gap < 2% ✓

10. Meta CAPI → purchase enviado com email_hash + fbclid (se consentido)
    → Event Match Quality calculado e logado

11. Dashboard → ROAS atualizado, funil mostra nova conversão, dado marcado "confiável"
```

---

## 15. RISCOS & DEPENDÊNCIAS *(novo na v3.0)*

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | **Identity resolution / stitching** é o núcleo mais frágil; ligar fbclid→compra cross-device depende de capturar email | Alto — sem isso, attribution erra | Spike técnico dedicado (Fase 4/5) com dados reais antes de construir M5–M10; fila idempotente e reprocessável |
| R2 | **Tese "delta positivo" pode ser over-attribution** | Fatal — vende número errado | M14 (reconciliação) construído antes dos módulos analíticos; gap < 2% obrigatório |
| R3 | **Aprovações de Ads API** (Meta/Google/TikTok) levam semanas | Alto — bloqueia M9/M10 | Iniciar burocracia já, em paralelo ao dev (seção 16) |
| R4 | **ToS das Ads APIs** podem restringir armazenar spend/criativos | Médio — bloqueia parte do M10 | Validar termos antes de construir M10 |
| R5 | **Complexidade operacional** (ClickHouse+Kafka+Redis+Supabase) para time pequeno | Médio — custo de manutenção | Docker local no dev; automação de infra; observabilidade (seção 13) desde cedo |
| R6 | **Custo de infra por evento** vs preço dos planos | Médio — margem | Modelar custo/evento antes de fixar pricing (seção 19); bot filtering (R7) |
| R7 | **Tráfego de bot** infla eventos, métricas e billing | Médio | M14 bot filtering; eventos de bot não contam |
| R8 | **LGPD/consentimento e envio de PII ao Meta** | Alto — legal | Consent manager, DPA, base legal (seção 11) |
| R9 | **Exclusão de dados no ClickHouse** é assíncrona/complexa | Médio — compliance | Pipeline de mutation com fila e confirmação (seção 11) |
| R10 | **Escopo enorme vs time** | Alto — prazo | Sem pressa de lançar (decisão do projeto); construção módulo a módulo com gate por fase |
| R11 | **Vazamento cross-tenant ou DoS pelo SQL self-serve** (M16) | Alto — segurança | SQL só em pool isolado, usuário read-only + ROW POLICY + QUOTA + views por workspace; `workspace_id` como invariante do compilador; testes de isolamento entre tenants falham o build |
| R12 | **Alucinação e custo do LLM** (M17) | Alto — confiança/margem | Arquitetura deterministic-first (o LLM só narra números já calculados); guardrails anti-alucinação; gate de plano + orçamento de tokens por workspace |

---

## 16. DEPENDÊNCIAS EXTERNAS & APROVAÇÕES DE API *(novo na v3.0)*

Iniciar **agora**, em paralelo ao código — são bloqueadores de caminho crítico que não
dependem de programação:

| Plataforma | O que obter | Prazo típico | Bloqueia |
|---|---|---|---|
| **Meta** | Business Verification + App Review (ads_read, CAPI) | 2–6 semanas | M9 (CAPI), M10 (criativos) |
| **Google Ads** | Developer Token (basic → standard access) | 1–4 semanas | M9 (Enhanced Conversions), M10 |
| **TikTok** | Marketing API access | 1–3 semanas | M9, M10 |
| **Shopify** | App (público ou custom) para webhooks + OAuth | 1–2 semanas | M4 |
| **Stripe** | Conta + produtos/prices; verificação para live | dias | M4, M11 |
| **MaxMind** | Licença GeoIP (GeoLite2 grátis ou GeoIP2 pago) | dias | M2 (enrich) |
| **Provedor de email** | Resend/Postmark + domínio verificado (SPF/DKIM) | dias | M12, M13 |
| **Anthropic API** | Chave + **DPA + zero data retention** + orçamento de tokens por workspace | dias | M17 (AI Journey) |
| **ClickHouse read pool** | Réplica/pool de leitura dedicado (Railway) separado da ingestão | dias | M16 (SQL self-serve) |

---

## 17. TELAS DO PRODUTO (referência para APIs)

### Auth (3)
Login `POST /auth/login` · Signup `POST /auth/signup` · Forgot Password (Supabase nativo).

### Onboarding (4)
Criar workspace `POST /workspaces` · Instalar pixel `GET /api-keys` · Conectar integração
`POST /integrations` · Onboarding completo → overview.
**+ Consentimento/cookies** configurado no onboarding *(novo)*.

### Overview (1)
KPI cards `GET /metrics/kpis` · Linha `GET /metrics/timeseries` · Top fontes
`GET /metrics/breakdown?dimension=utm_source` · Mini funil `GET /funnels/:id/stats`.

### Funnels (3)
Lista `GET /funnels` · Visualização `GET /funnels/:id/stats` + `/dropoff/:stepId` ·
Builder `POST/PATCH /funnels` + `GET /funnels/:id/preview`.

### Dashboards (4)
Lista `GET /dashboards` · Visualização `GET /dashboards/:id/data` · Builder `POST/PATCH` ·
Widget seletor `GET /metrics/kpis`.

### Attribution (4)
Report · Campaign Breakdown · Conversion Paths · Comparação de modelos.

### Creatives (3)
Overview grid/tabela · Detalhe · Comparação.

### Tracking (3)
Pixel config · Tracking links · Debug view `GET /events/recent` (polling).

### Integrations (2)
Lista · Configuração + logs.

### Settings (5)
Workspace · Membros · API Keys · Billing · **Privacidade/Consentimento & DPA** *(novo)*.

### Notificações & Alertas (2) *(novo)*
Central de notificações · Regras de alerta + preferências.

### Relatórios (2) *(novo)*
Lista/agendamentos · Builder de relatório white-label.

### Qualidade de Dados (1) *(novo)*
Painel de reconciliação + bot report + discrepância.

### Customer Profile / User 360 (4) *(novo na v3.2)*
Busca de usuário · Perfil consolidado (identidade + métricas + jornada) · Timeline de eventos
(agrupada por dia, filtros, expansível) · Identidades fundidas.

### Data Explorer (4) *(novo na v3.2)*
Construtor visual no-code (`POST /explorer/query`) · Editor SQL guardado (`/explorer/sql`,
Agency/Ent) · Biblioteca de insights salvos (versões, share, add ao dashboard) · Catálogo/
dicionário de dados.

### AI Journey Intelligence (3) *(novo na v3.2)*
Objetivo & ranking de melhores jornadas por canal · Insights & recomendações (com "ver dado") ·
AI Ask (pergunta em linguagem natural, mostra a query traduzida).

---

## 18. CRITÉRIOS DE SUCESSO

### Produto
- Pixel instalado em < 10 minutos por não-desenvolvedor.
- Primeiro funil com dados reais em < 30 minutos.
- Dashboard carrega em < 2s para 90 dias.
- **Delta positivo E reconciliado:** Truvo mostra mais conversões que o Meta **e** bate com
  a receita real do gateway (gap < 2%) *(refinado na v3.0)*.

### Negócio
- 20+ workspaces pagantes.
- MRR R$20.000+.
- Churn mensal < 5%.
- NPS > 40.

> ℹ️ **Sobre prazo:** como o projeto optou por construir o produto completo sem pressa de
> lançar, as metas de negócio não têm data fixa — elas valem **a partir do lançamento**, que
> ocorre quando o produto completo estiver validado (marco M14 + módulos essenciais rodando).

### A métrica que valida tudo
> Se o cliente vê mais conversões **reconciliadas** no Truvo do que no painel do Meta, ele
> nunca cancela. O delta entre o que as plataformas reportam e o que **realmente acontece
> e bate com o caixa** é o produto.

---

## 19. PRICING — CONSIDERAÇÕES *(novo na v3.0)*

- **Modelar custo por evento** (armazenamento ClickHouse + processamento) antes de fixar preços.
- **Curva de planos:** Starter→Growth é 10x eventos (100k→1M) por 2,3x preço (R$297→R$697).
  Revisar para não comprimir margem no Growth.
- **Bot filtering** protege tanto a métrica quanto a receita — eventos de bot não contam.
- **Excedente:** Usage Records no Stripe cobram eventos além do plano.
- **White-label e multi-workspace** são o que justificam o Agency — precificar o valor,
  não o custo.

---

## 20. CHANGELOG

- **v3.2 (Jul/2026):** três módulos novos — M15 (Customer Profile / User 360), M16 (Data
  Explorer, motor de query próprio: visual + SQL guardado) e M17 (AI Journey Intelligence,
  deterministic-first + Claude). Novas regras 14–20; Anthropic como subprocessador (DPA +
  zero data retention); riscos R11 (vazamento/DoS via SQL self-serve) e R12 (alucinação/custo
  de LLM); novas tabelas (user_profiles, profile_access_log, insights, insight_versions,
  insight_shares, explorer_catalog, ai_*; ClickHouse explorer_query_log, journey_paths_daily);
  infra de query self-serve (pool de leitura dedicado, row policy, quota). Fronteiras entre
  M15/M16/M17 e decisões pendentes no fim da seção 7.
- **v3.0 (Jul/2026):** Seção 0 (Decisões), 5 (Arquitetura & Ambientes), 6 (Roadmap por fases),
  10 (Validação & Qualidade), 13 (Observabilidade), 15 (Riscos), 16 (Dependências externas),
  19 (Pricing). Novos módulos M12 (Notificações), M13 (Relatórios), M14 (Qualidade de Dados).
  Compliance aprofundado (consentimento, DPA, exclusão em ClickHouse). Novas regras de negócio
  11–13. Encoding corrigido. Decisões fixadas: Supabase Cloud no dev, front-end greenfield.
- **v2.0 (Mai/2026):** versão base com 11 módulos, event model, endpoints, DB, fluxo de dados.
