# ORDER 140 — Truvo Product Analytics v1

## Execution authority

- **Execution Order:** 140
- **Work Item:** Truvo Product Analytics v1
- **Implementation Spec:** SPEC-23 — Truvo Product Analytics v1 — Implementation Spec
- **Baseline branch:** `main`
- **Baseline SHA:** `e2e8ec310a661c3d82f893d293ef937952b24c27`
- **Recommended branch:** `order-140-product-analytics-v1`
- **Priority:** P1
- **Phase:** MVP
- **Code State:** Partial
- **Reuse Strategy:** Adapt
- **Dependency status:** Order 150 DONE
- **Next step after DONE:** MVP release-cut / milestone validation

## Mission

Instrumentar o funil de produto da própria Truvo, do workspace criado até o primeiro valor, sem misturar telemetria do SaaS com os eventos de negócio do cliente.

Este Order é uma camada **lean de Product Analytics para o MVP**. Não é uma plataforma ampla de analytics, não é um novo customer-event pipeline e não deve criar uma segunda fonte de verdade para onboarding.

## Required product events

- `workspace_created`
- `integration_connected`
- `integration_failed`
- `first_event_received`
- `context_ready`
- `radar_created`
- `radar_ready`
- `radar_failed`
- `opportunities_generated`
- `opportunity_viewed`
- `audience_exported`
- `activation_requested`
- `activation_completed`
- `activation_failed`
- `first_outcome_observed`

## Reuse obrigatório do Order 120

Já existem fatos canônicos em `onboarding_progress`:

- `started_at`
- `healthy_context_at`
- `data_verified_at`
- `readiness_viewed_at`
- `first_radar_initiated_at`
- `first_radar_created_at`
- `completed_at`

`OnboardingService` já deriva `ttfvMs` de `started_at` para `first_radar_created_at`.

`onboarding_milestones` já contém:

- `onboarding_started`
- `onboarding_path_selected`
- `context_connection_started`
- `context_connection_succeeded`
- `context_connection_failed`
- `incoming_data_verified`
- `readiness_viewed`
- `first_radar_initiated`
- `first_radar_created`
- `onboarding_completed`

Esses fatos continuam canônicos. Não criar outro onboarding state machine nem timestamps concorrentes.

## Separate product-event storage

Criar persistência interna separada do customer `EventSchema`, preferencialmente uma tabela Postgres pequena como `truvo_product_events` ou equivalente.

Campos mínimos:

- event id
- `workspace_id`
- allowlisted `event_name`
- `occurred_at`
- deterministic `idempotency_key`
- metadata estritamente allowlisted
- `created_at`

Usar a próxima migration válida após `0024` depois de auditar a main atual.

Requisitos:

- workspace-scoped
- append-only event facts
- deterministic duplicate prevention
- indexes para workspace/event/time
- sem customer payload
- sem email/telefone/nome/endereço
- sem credentials/secrets
- sem raw URLs/queries contendo PII
- sem provider error livre

## ProductAnalyticsService

Implementar um serviço interno narrow e transaction-aware, como `ProductAnalyticsService`.

Responsabilidades:

- registrar transições canônicas
- idempotência
- validar allowlist de metadata
- produzir funil por workspace
- produzir métricas derivadas

Retry/replay deve ser no-op quando o mesmo evento lógico já existe.

## Canonical instrumentation map

Instrumentar nos pontos canônicos reais:

### workspace_created
Emitir após workspace realmente ser persistido/commitado.

### integration_connected
Emitir na transição canônica para conexão saudável/conectada. Nunca em GET/poll/render.

### integration_failed
Emitir na falha canônica de conexão usando reason code bounded; nunca raw provider error.

### first_event_received
Exatamente uma vez por workspace quando o primeiro customer/business event real for aceito/persistido. Não copiar o payload do evento.

### context_ready
Exatamente uma vez a partir do primeiro contexto saudável/readiness canônico. Reusar fatos do Order 120.

### radar_created
Emitir na persistência canônica do Radar. Replay não duplica.

### radar_ready
Emitir na transição canônica para ready/validated/usable.

### radar_failed
Emitir na falha canônica relevante com bounded reason code.

### opportunities_generated
Emitir quando um batch/materialização canônica completar; usar batch identity para dedupe.

### opportunity_viewed
É interação de produto. Criar um caminho autenticado, workspace-scoped e allowlisted. Não usar React render como sinônimo de view e não enviar customer payload/PII.

### audience_exported
Emitir quando export realmente completar.

### activation_requested
Emitir quando activation é criada/solicitada canonicamente.

### activation_completed
Emitir quando activation realmente completa com sucesso.

### activation_failed
Emitir na falha canônica com bounded reason code.

### first_outcome_observed
Exatamente uma vez por workspace quando o primeiro outcome canônico real é persistido/reconciliado.

## Privacy contract

Não aceitar arbitrary event names nem arbitrary JSON properties.

Proibir explicitamente:

- email
- phone
- customer name
- customer ID
- customer/order/event payload
- raw URL/query com identificadores
- provider error livre
- credential/secret
- arbitrary nested customer data

Permitir somente metadata low-cardinality e já necessária, por exemplo:

- source/provider category
- Radar type
- activation destination category
- plan/feature cohort quando já disponível
- bounded reason code

Adicionar testes de privacy/PII.

## Per-workspace activation funnel

Disponibilizar query/service que produza os primeiros timestamps para:

- workspace created
- integration connected
- first event received
- context ready
- first Radar created
- first Radar ready
- opportunities generated
- first opportunity viewed
- first export/activation
- first outcome observed

Sem log scraping.

## TTFV

Não redefinir silenciosamente a métrica existente.

Preservar explicitamente:

`timeToFirstRadarMs = first_radar_created_at - onboarding.started_at`

Se implementar tempo até primeira oportunidade, usar outro nome como `timeToFirstOpportunityMs`.

## Aggregate MVP metrics

Implementar queries suficientes para:

- activation funnel conversion por step
- median/p50 Time to First Radar
- first Radar rate
- Radar readiness rate
- first opportunity rate
- activation/export rate
- retained active Radar workspaces

Definir `retained active Radar workspace` de forma objetiva e documentar a rolling window.

Não construir dashboard amplo neste Order.

## Idempotency proofs

Provar:

- workspace retry não duplica `workspace_created`
- connector polling não duplica `integration_connected`
- repeated ingestion não duplica `first_event_received`
- readiness read/retry não duplica `context_ready`
- Radar replay não duplica `radar_created`
- opportunity replay respeita batch identity
- activation replay não duplica requested/completed
- multiple outcomes só geram um `first_outcome_observed`

## Product-funnel regression fixture

Criar uma progressão determinística que chegue a:

`workspace_created → integration_connected → first_event_received → context_ready → radar_created → radar_ready → opportunities_generated → opportunity_viewed → activation_requested/completed ou audience_exported → first_outcome_observed`

Depois consultar o funil e provar ordem, timestamps, durations, dedupe e workspace isolation.

## Test command

Adicionar:

`pnpm test:product-analytics`

Deve cobrir:

- contracts
- privacy
- idempotency
- canonical transitions
- derived funnel
- TTFV
- aggregates

Integrar ao existing pre-beta/release path se estável e não duplicativo.

## Final validation

Após a última alteração, executar:

```bash
pnpm install --frozen-lockfile
pnpm migration:validate
pnpm test:product-analytics
pnpm test:onboarding
pnpm test:app-shell
pnpm test:demo-workspace
pnpm test:prebeta
pnpm test:opportunities
pnpm test:decisions
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Rodar também focused tests dos subsystems instrumentados.

Exigir 0 fail e 0 relevant skip.

## Diff hygiene

```bash
git diff --check
git status
git diff origin/main...HEAD
git diff origin/main -- docs/exec/ACTIVE_WORK_ITEM.md
```

`ACTIVE_WORK_ITEM.md` deve ter zero diff.

Não incluir:

- Personalization
- Experimentation
- analytics dashboard amplo
- Session Replay
- data warehouse genérico
- customer event redesign
- UI/brand redesign
- unrelated refactors
- logs/test artifacts/secrets

## Publication and review

1. Commit apenas Order 140 em `order-140-product-analytics-v1`.
2. Push normal, nunca force-push.
3. Abrir um único PR contra `main`.
4. Aguardar required CI no SHA final.
5. Pedir `@codex review`.
6. **Aguardar o review realmente terminar no SHA final antes de mergear.**
7. Corrigir todo P0/P1/P2 no mesmo PR.
8. Após cada fix: testes afetados → commit → push → CI → fresh review.
9. Exigir zero unresolved review threads.
10. Protected merge only.
11. Verificar `main`, CI pós-merge e review threads novamente depois do merge.

## DONE criteria

Order 140 só é DONE quando:

- Truvo product events estão separados de customer events
- event coverage SPEC-23 está completo ou explicitamente derivado de fonte canônica
- telemetry de onboarding é reutilizada, não duplicada
- backend events são idempotentes
- PII/customer payload não entra na telemetria
- `opportunity_viewed` tem caminho seguro
- funil por workspace é queryable
- TTFV está definido e testado
- aggregates MVP são computáveis
- retained active Radar definition está explícita
- `pnpm test:product-analytics` passa
- todos os regression/final gates passam
- remote CI passa
- fresh final Codex review no exact final SHA tem 0 P0/P1/P2
- unresolved threads = 0
- protected merge completa
- main contém Order 140
- post-merge CI passa

## Explicit non-goals

Não construir dashboard geral, warehouse genérico, Session Replay, third-party analytics vendor, customer-level tracking com PII, Personalization, Experimentation ou outro onboarding state machine.

## Final handoff

Retornar `TRUVO HANDOFF` com:

- Execution Order: 140
- Work Item: Truvo Product Analytics v1
- Result: DONE / PARTIAL
- baseline SHA
- final branch SHA
- PR URL
- event → canonical source map
- schema/storage choice
- privacy allowlist/denylist proof
- duplicate prevention proof
- onboarding reuse proof
- workspace activation funnel proof
- TTFV definition/proof
- aggregate metric proof
- retained active Radar definition
- `test:product-analytics`
- affected regression gates
- final gates
- remote CI
- fresh final Codex review SHA/result
- unresolved review thread count
- merge SHA
- main SHA
- post-merge CI
- blockers if PARTIAL
- recommendation for MVP release-cut only if DONE

Do not start future Personalization/Experimentation work in this execution.
