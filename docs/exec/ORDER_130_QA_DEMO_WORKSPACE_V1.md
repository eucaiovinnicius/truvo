# ORDER 130 — QA & WORKSPACE DE DEMONSTRAÇÃO V1

**Execution Order:** 130  
**Work Item:** QA & Workspace de Demonstração v1  
**Implementation Spec:** SPEC-21 — QA & Workspace de Demonstração v1 — Especificação de Implementação  
**Priority:** P0  
**Phase:** MVP / Reliability  
**Code State:** Partial  
**Reuse Strategy:** Adapt  
**Status:** Ready  
**Readiness:** Build Ready  
**Baseline SHA:** `581f2b508542b1472e23f185cdd0c5eccd096e97`  
**Branch:** `order-130-qa-demo-workspace`  
**Expected Result:** `DONE`

---

## 0. Mission

Entregar uma infraestrutura reproduzível de QA e workspace de demonstração para o loop central da Truvo:
`Measure → Predict → Experiment → Decide → Act → Measure Incrementality → Learn`
e seu centro de produto:
`Customer Context → Radars → Propensity → Revenue Opportunities → Activation → Learning`.

A solução permite que qualquer novo agente ou pipeline de CI execute uma jornada determinística de ponta a ponta e detecte regressões reais de produto.

### Escopo obrigatório
1. **Workspace de demonstração determinístico:** Entrypoint canônico para criar/resetar workspace de demo/QA com dados conhecidos e IDs estáveis.
2. **Dataset sintético versionado:** Entidades completas (customers, accounts, products, orders, subscriptions, CRM attributes, engagement events, anonymous → known identity transitions) cobrindo as 6 personas de SPEC-21:
   - Persona 1: Provável comprador (likely buyer)
   - Persona 2: Não comprador (non-buyer)
   - Persona 3: Comprador recorrente (repeat buyer)
   - Persona 4: Candidato a upgrade de assinatura (subscription upgrade candidate)
   - Persona 5: Histórico semelhante a churn (churn-risk / churn-like history)
   - Persona 6: Histórico insuficiente (insufficient history)
3. **Fixtures portáveis e sanitizadas de conectores:** Payloads de ingestão/conectores existentes (Shopify, Stripe, HubSpot, Klaviyo) sem segredos, tokens ou dados reais de produção, comprovando transformações source → canônico e tratamento de payloads inválidos.
4. **Isolamento de tenants (Tenant Isolation):** Prova rigorosa em runtime/API/queries entre Workspace A e Workspace B (cross-tenant read/mutation denied, runtime context guard).
5. **Golden E2E do loop central:** Jornada determinística completa:
   `workspace → seed/input → canonical context → anonymous-known identity merge → Radar → scoring → opportunity → activation/export → result/decision`.
6. **Regression Gate:** Comando root canônico `pnpm test:demo-workspace` integrado a `pnpm test:prebeta` e ao CI de release.

---

## 1. Regras de Execução e Reuse First

- Reutilizar a arquitetura existente da Truvo:
  - Canonical Customer Context (`packages/db`, `apps/api`)
  - Identity Graph e identity merge
  - Radar runtime e lifecycle (`RadarService`, `test-radars-runtime.mjs`)
  - Propensity scoring e Model Registry (`packages/db`, `apps/api`)
  - Materialized Revenue Opportunities (`OpportunityEngineService`, `test-opportunities-runtime.mjs`)
  - Decision & Action Ledger (`DecisionLedgerService`, `test-decisions-runtime.mjs`)
  - Scripts de teste existentes em `scripts/`
- Não criar implementações paralelas ou mocks falsos para contornar verificações de domínio.
- Stubs permitidos apenas em chamadas externas a provedores de rede (Shopify/Stripe/HubSpot/Klaviyo).
- Zero PII real, zero secrets, zero tokens em fixtures.
- Execução determinística e independente de timing ou latência de rede.

---

## 2. Gates e Critério de Aceitação

1. `DEMO DATA`: Versionado, determinístico, portátil, 6 personas, reset reproduzível.
2. `CONNECTOR FIXTURES`: Sanitizadas, source → canonical verificado, secrets ausentes.
3. `TENANT ISOLATION`: Cross-tenant read denied, cross-tenant mutation denied, isolamento estrito de runtime.
4. `GOLDEN E2E`: Loop central completo passando de ponta a ponta com asserções de domínio.
5. `REGRESSION GATE`: `pnpm test:demo-workspace` passando com 0 fail e 0 skip, integrado aos gates canônicos.
6. `FINAL GATES`:
   - `pnpm install --frozen-lockfile`
   - `pnpm migration:validate`
   - `pnpm test:demo-workspace`
   - `pnpm test:onboarding`
   - `node scripts/test-radars-runtime.mjs`
   - `pnpm test:prebeta`
   - `pnpm test:opportunities`
   - `pnpm test:decisions`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
7. `REMOTE CI & CODEX REVIEW`:
   - PR aberto contra `main`
   - CI verde no head SHA
   - Fresh Codex review no head SHA limpo (0 P0/P1/P2)
   - 0 review threads não resolvidas
   - Merge protegido concluído para `main`
