# TRUVO — Product Requirements & Migration Plan v4.4

> **AI Revenue Intelligence**
>
> **Know who will buy next.**
>
> Version: **4.4**  
> Migration audit date: **2026-08-16**  
> Repository basis: existing Truvo PRD v3.2 codebase.
>
> **This document is the implementation source of truth for Codex.**

---

# 0. Instructions for Codex

## Mission

Evolve the **existing Truvo v3.2 repository** into **Truvo 4.x — AI Revenue Intelligence**.

This is **not a greenfield rebuild**.

The current repository already contains substantial production-oriented implementation for authentication, workspaces, event ingestion, async event processing, ClickHouse persistence, native tracking, webhooks, identity, attribution, data quality, billing, conversion destinations, analytics surfaces and an existing application shell.

Your job is to:

1. preserve working assets;
2. stabilize the current repository;
3. adapt the existing data foundation into Canonical Customer Context;
4. build the new predictive product above it;
5. execute the migration in the order defined in this document.

## Mandatory execution protocol

Do **not** attempt to implement the entire roadmap in one pass.

Work sequentially by `Execution Order`.

For each work item:

1. inspect the existing implementation first;
2. verify its `Code State` and `Reuse Strategy`;
3. implement the smallest complete unit that satisfies the acceptance criteria;
4. preserve backward compatibility unless the work item explicitly authorizes a migration;
5. run the relevant tests, lint/typecheck/build and migrations;
6. report files changed, migrations, tests, validation results, remaining risks and blockers;
7. do not silently invent product requirements or architecture decisions.

If a required architectural/product decision is not covered here, **stop and report the decision required** instead of making a broad redesign.

## Current first executable task

The first task is:

**Execution Order 10 — Repository Baseline & Green CI**

Do not begin Canonical Customer Context migrations before this gate is green.

---

# 1. Product definition

Truvo is an **AI Revenue Intelligence** platform that identifies:

- where the next revenue opportunity is;
- which customer or account is most likely to generate it;
- which action should be taken next.

Primary commercial communication:

> **Know who will buy next.**

“Buy” is the simplest commercial wording. The actual outcome is configurable.

Examples of target outcomes:

- purchase;
- rebuy;
- subscribe;
- upgrade;
- cross-sell;
- reactivate;
- app adoption;
- trial;
- activation;
- custom outcome.

The mental territory Truvo should own is:

> **“Truvo knows where my next revenue is.”**

---

# 2. Product thesis

Companies already have valuable customer and revenue data, but it is fragmented across commerce, CRM, billing, engagement platforms, product analytics, ads, CDPs, warehouses and Truvo-native tracking.

Truvo converts this fragmented context into an intelligence loop:

```text
Measure
  ↓
Predict
  ↓
Experiment
  ↓
Decide
  ↓
Act
  ↓
Measure Incrementality
  ↓
Learn
```

The product evolves through five layers:

1. **Revenue Data** — capture or connect trustworthy customer and business context.
2. **Revenue Intelligence** — predict customer outcomes and expected value.
3. **Revenue Opportunities** — convert scores into prioritized economic opportunities.
4. **Revenue Decisioning** — recommend the best allowed action.
5. **Learning** — measure lift/incrementality and improve future decisions.

---

# 3. Core product object: Radar

The primary object in the new Truvo is the **Radar**.

The user should not need to think in terms of machine-learning models.

The user answers:

> **What do you want to predict?**

A Radar defines:

- Target Outcome;
- Audience;
- Prediction Window;
- Optimization Goal;
- Constraints;
- Activation destinations.

Example Radar templates:

- Purchase Radar;
- Rebuy Radar;
- Subscription Radar;
- Upgrade Radar;
- Cross-sell Radar;
- Winback Radar;
- Custom Radar.

Initial Radar support must include:

- purchase;
- custom event/outcome.

A Radar produces **Revenue Opportunities**.

Revenue Opportunities are prioritized by:

1. propensity;
2. expected value when available;
3. later, expected incremental value.

---

# 4. Customer outcome model

The system should be designed around:

> **Who will do X next?**

Examples:

```text
Who will purchase in the next 14 days?
Who will subscribe in the next 30 days?
Who will upgrade from Basic to Pro?
Who will buy Product Category B?
Who will reactivate?
Who will complete app activation?
Who will book a demo?
Who will trigger a custom business outcome?
```

A Radar is conceptually:

```text
Radar =
  Audience
  + Target Outcome
  + Prediction Window
  + Model
  + Opportunity Value
```

Events are observations. Goals/outcomes are the business results Truvo predicts.

Do not conflate raw events with business outcomes.

---

# 5. Prediction is not causality

This distinction is non-negotiable.

## Propensity

Answers:

> Who is likely to do X?

## Uplift

Answers:

> For whom will intervention Y actually increase the probability of X?

A customer with a 90% probability of purchasing may not need a discount.

Therefore:

> **Do Nothing is a valid action.**

Long-term, the system should learn from:

```text
Context
→ Prediction
→ Decision
→ Action
→ Exposure
→ Outcome
→ Reward
```

Every decision eventually needs:

- decision ID;
- model version;
- policy version;
- context snapshot;
- assigned action;
- executed action;
- exposure;
- target outcome;
- observed outcome;
- reward.

The long-term question is:

> **What should we do now to create revenue that would not happen otherwise?**

---

# 6. North Star

Do not optimize Truvo around the claim that it “found more conversions than the ad platform.”

Attributed revenue and incremental revenue are different concepts.

The long-term North Star is:

> **Incremental Revenue generated from Truvo opportunities**

Preferred economic North Star:

> **Incremental Gross Profit**

Attribution may remain an important measurement primitive, but attribution must never be presented as causal incrementality.

---

# 7. How Truvo gets customer context

Truvo should support three operating modes.

## Truvo-native

- browser tracking;
- track/identify;
- server-side events;
- webhooks;
- identity;
- attribution.

## Bring Your Own Stack

Truvo may consume context already available in:

- CDPs;
- event platforms;
- warehouses;
- CRMs;
- attribution systems;
- engagement systems.

## Hybrid

Truvo combines existing customer data with additional sources such as:

- Shopify;
- HubSpot;
- Stripe;
- Klaviyo;
- Truvo Events.

This openness is a strategic architecture capability, **not the primary marketing headline**.

> **Integrate aggressively in execution; own the intelligence that decides.**

---

# 8. What Truvo must own

The proprietary core should become:

- Canonical Customer Context;
- customer identity needed for unified context;
- Event / Context Intelligence;
- Attribution / Revenue Truth where useful;
- Radars;
- Propensity;
- Expected Value;
- Revenue Opportunities;
- Decision & Action Logging;
- Experimentation / Holdouts;
- Incrementality;
- Next Best Action;
- Learning Engine.

Do not unnecessarily rebuild tools that customers already use successfully.

---

# 9. Existing repository: architectural reality

The repository is **not an empty prototype**.

## Repository inventory

### `apps/api`
Existing NestJS API modules include auth, workspaces, events, webhooks, funnels, metrics, attribution, identity, profiles, data quality, billing, reports, creatives, integrations and AI Journey.

### `apps/consumer`
Existing async infrastructure includes Kafka/Redpanda event processing, enrichment, billing counters and identity stitching workers.

### `apps/web`
Existing Next.js application shell and legacy product screens.

### `packages/db`
Existing Postgres / ClickHouse schemas and migrations.

### `packages/event-schema`
Existing normalized EventSchema and source-priority contracts.

### `packages/pixel`
Existing first-party browser tracking package.

### CI / deploy
Existing GitHub Actions, Docker / Docker Compose, Railway configuration, Vercel configuration and deployment documentation.

---

# 10. Non-greenfield ADR

> **Truvo 4.x evolves the existing v3.2 codebase. It must not be rebuilt from zero.**

Preserve or adapt existing implementations wherever technically reasonable.

Do not create parallel replacement subsystems merely because the v4 architecture uses different terminology.

---

# 11. Reuse map

| Capability | Current state | Truvo 4.x action |
|---|---|---|
| Auth / Workspaces | Implemented | Keep |
| Event Pipeline | Implemented | Keep; feed Canonical Context |
| Native Tracking / Pixel | Implemented | Keep; preserve compatibility |
| Identity Graph | Strong v1 | Refactor to v2 |
| Attribution | Legacy complete | Keep as Revenue Truth / measurement |
| Funnels / KPIs / Dashboard | Legacy complete | Preserve; remove from Radar critical path |
| Data Quality | Partial for v4 | Adapt to Event + Context Readiness |
| Shopify | Webhook event intake exists | Adapt to full context connector |
| Stripe | Webhook event intake exists | Adapt to full context connector |
| HubSpot | Inbound + outbound partial | Adapt to full CRM context connector |
| Klaviyo | Absent | Build |
| Radars | Absent | Build |
| Propensity | Absent | Build |
| Revenue Opportunities | Absent | Build |
| Decision / Action ledger | Partial primitives | Adapt + build canonical ledger |
| MLOps / Model Registry | Absent for propensity | Build |

---

# 12. Legacy capability policy

Do not delete these existing modules simply because they are outside the Radar MVP critical path:

- Funnels;
- dashboards;
- KPI builder;
- creative analytics;
- reports;
- Data Explorer;
- Customer Profiles / User360;
- notifications;
- AI Journey Intelligence.

Policy:

- preserve;
- keep compilable;
- adapt only when useful;
- do not prioritize before the Radar MVP;
- do not present AI Journey as the new propensity engine.

---

# 13. Target migration architecture

```text
Existing Truvo v3.2
Events + Tracking + Webhooks + Identity + Attribution
                │
                ▼
      Canonical Customer Context
                ▲
                │
        Connector Framework
                ▲
                │
 Shopify / HubSpot / Stripe / Klaviyo / BYO
                │
                ▼
         Identity Graph v2
                │
                ▼
        Context Readiness
                │
                ▼
              Radars
                │
                ▼
       Propensity Models
                │
                ▼
     Revenue Opportunities
                │
                ▼
       Activation / Export
                │
                ▼
  Decision + Outcome Logging
                │
                ▼
 Experimentation / Uplift / Learning
```

---

# 14. Canonical Customer Context

The canonical model must represent, at minimum:

- Customer;
- Event;
- Trait / State;
- Relationship;
- Outcome;
- external IDs.

The migration must be **additive** over the current EventSchema/profile/identity foundation.

Existing EventSchema behavior must remain compatible.

Do not silently change event semantics.

---

# 15. EventSchema compatibility requirements

Preserve compatibility with:

- current EventSchema;
- browser `track`;
- `identify`;
- server-side event API;
- webhook-normalized events;
- `event_id` deduplication;
- `order_id` deduplication;
- source-priority semantics;
- legacy measurement behavior where still used.

Canonical Context must receive deterministic mapping from the existing event system.

---

# 16. Identity Graph v2

Preserve:

- existing `identity_links`;
- existing `identity_merges`;
- canonical IDs;
- retroactive stitching;
- merge history.

Current identifier uniqueness is effectively:

```text
workspace_id + identifier
```

Identity v2 must use collision-safe namespace semantics conceptually equivalent to:

```text
workspace_id
+ identifier_type
+ identifier
```

Identity v2 must add or guarantee:

- multi-source external IDs;
- explicit conflict handling;
- auditable merge history;
- reversibility where technically supported;
- no silent conflict merge;
- historical stitching.

---

# 17. Connector Framework

Create a shared Connector Framework that wraps existing implementations.

A connector contract must support, as applicable:

- source-only;
- destination-only;
- bidirectional;
- credentials / OAuth isolation;
- historical sync;
- incremental sync;
- cursor/checkpoint;
- retries;
- idempotency;
- canonical mapping;
- observability;
- backfill/reconciliation;
- activation/write-back.

Preserve existing working webhook and destination endpoints through migration where possible.

---

# 18. Initial connectors

## Shopify

Existing webhook ingestion and normalization should be expanded to full context:

- customers;
- orders;
- products;
- refunds;
- commerce traits;
- historical reconciliation;
- backfill;
- sync cursor/state;
- preserved external IDs;
- documented canonical mappings.

## HubSpot

Expand to:

- contacts;
- companies;
- deals;
- lifecycle/stage;
- essential activities;
- historical/backfill;
- incremental updates;
- configurable mapping;
- score/trait write-back.

### Critical bug/risk

HubSpot webhooks may arrive as arrays/batches.

The legacy normalizer may effectively process only the first event.

The v4 adaptation must process **every event in a batch idempotently**.

## Stripe

Expand existing billing lifecycle events into context for:

- customers;
- subscriptions;
- invoices;
- payments;
- plans;
- subscription state;
- billing traits;
- historical backfill;
- incremental sync;
- canonical external IDs.

## Klaviyo

No real production Klaviyo connector was found in the audited repository.

Build it on the shared Connector Framework.

Required MVP capabilities:

- read supported engagement context;
- read supported campaign/flow context;
- create/update profiles or segments needed for activation;
- preserve exposure/outcome correlation in Truvo.

---

# 19. Event & Context Quality Engine

Reuse legacy data-quality primitives.

The engine should detect:

- missing identifiers;
- schema divergence;
- duplicate data;
- source coverage gaps;
- missing properties;
- integration/context problems that prevent Radar training.

Expose a usable **Tracking / Context Health Score** with actionable fixes.

---

# 20. Create Radar v1

Required:

- target outcome;
- audience;
- prediction window;
- minimum-data validation;
- Radar persistence;
- preparation/model state;
- purchase outcome;
- custom event/outcome.

The legacy AI Journey objective/run model may inspire async workflow patterns.

Do **not** reuse AI Journey semantics as prediction semantics.

---

# 21. Propensity Modeling v1

This is a new ML capability.

Required:

- customer-level labeled datasets;
- temporal feature construction;
- strict prevention of future leakage;
- appropriate train/validation split;
- training per Radar;
- calibrated probability;
- model versioning;
- batch scoring;
- AUC;
- precision/recall-oriented metrics;
- calibration metrics;
- insufficient-data fallback/state.

Output:

```text
P(target_outcome occurs within prediction_window | customer context)
```

Do not claim causality from propensity.

---

# 22. MLOps & Model Registry v1

Persist:

- model version;
- feature-definition version;
- training cutoff;
- evaluation metrics;
- model state;
- active/retired state;
- model version attached to every score.

Support retraining, rollback, failed-model state and insufficient-data state.

---

# 23. Revenue Opportunities v1

Create a new customer/opportunity ranking layer.

Required:

- Radar filter;
- propensity;
- expected value when available;
- score filtering;
- opportunity detail;
- prediction window;
- important signals/explanation;
- export or activation handoff.

Conceptually:

```text
Expected Revenue = probability × estimated outcome value
```

Do not label this incremental revenue unless incrementality has actually been measured.

---

# 24. Decision & Action Logging

Create a canonical decision ledger capable of recording:

- `decision_id`;
- customer/context reference;
- `model_version`;
- `policy_version`;
- context snapshot/reference;
- action assigned;
- action executed;
- exposure;
- target outcome;
- observed outcome;
- reward/economic result.

Existing recommendation/output logs may be reused as patterns.

---

# 25. Activation

The MVP must support at least one practical handoff:

```text
Radar
→ scored audience
→ Revenue Opportunities
→ export / connector destination
→ exposure
→ observed outcome
```

Future Next Best Action will decide:

```text
WHO × WHAT × WHEN × WHERE × OFFER
```

But causal Next Best Action is **not** required for the initial Radar MVP.

---

# 26. Experimentation and incrementality — after MVP

After sufficient usage/data:

## Experimentation & Holdouts

- random assignment;
- persistent control/holdout;
- exposure logging;
- outcome windows;
- variant analysis;
- sample-ratio mismatch guardrails.

## Uplift Modeling

- treatment vs. control effect estimation;
- uplift/Qini-style evaluation;
- Do Nothing baseline;
- promotion only with adequate experimental evidence.

## Incremental Revenue / Profit

Report separately:

- attributed conversions/revenue;
- incremental conversions;
- incremental revenue;
- incremental gross profit.

Never silently conflate them.

---

# 27. Live Data Truthfulness

This is a P0 correctness requirement.

Current frontend patterns can allow live API failure to result in mock data being rendered by screens using logic comparable to:

```text
live.data ?? MOCK
```

## Required invariant

### Demo mode
Synthetic data is allowed when explicitly in demo mode.

### Live mode
API failure or unavailable data must **never** silently fall back to synthetic business metrics.

Standardize:

- loading;
- empty;
- error;
- stale/degraded;
- permission states.

Regression tests must cover:

> **No silent mock data in live mode.**

---

# 28. Security, privacy and data lifecycle

Preserve existing:

- tenant/workspace isolation;
- security guards;
- hashed identifiers;
- encrypted integration credentials;
- consent-related primitives;
- access auditing;
- tombstone-aware reads.

Add a complete auditable subject erasure/anonymization path across applicable:

- Postgres canonical/customer data;
- profile data;
- identity data;
- ClickHouse event data;
- caches;
- derived/model artifacts.

Requirements:

- workspace scope;
- authorization;
- auditability;
- idempotency;
- retryability;
- retention enforcement;
- tombstone/re-ingestion protection.

---

# 29. UX direction

Reuse the existing app shell/components.

Do not redesign brand identity as part of migration.

Refocus product navigation around:

- Opportunities;
- Radars;
- Customers;
- Data;
- Integrations;
- Measure.

New onboarding:

```text
Create workspace
→ Connect Context / install Truvo Events
→ Validate Data Readiness
→ Create Radar
→ Receive first Revenue Opportunities
```

---

# 30. MVP end-to-end experience

```text
Connect context
→ Create Radar
→ Score customers
→ Show Revenue Opportunities
→ Activate/export
→ Observe outcome
```

Migration success means an existing Truvo workspace can:

1. continue ingesting legacy EventSchema data;
2. synchronize additional customer context;
3. preserve stable identity;
4. create a Radar;
5. receive real per-customer propensity scores;
6. see Revenue Opportunities;
7. export or activate them;
8. observe outcomes;
9. do all of the above with **no silent synthetic-data fallback**.

---

# 31. Critical implementation risks

## Critical — Live mock fallback
Live mode may display synthetic metrics after an API failure.

## High — Identity namespace collision
Current Identity v1 uniqueness does not sufficiently encode identifier type.

## High — HubSpot webhook batching
Legacy HubSpot normalization may process only the first event in a batched payload.

## High — Clean baseline not yet reproduced
No v4 schema migration starts before **Repository Baseline & Green CI** is proven in the real development environment.

---

# 32. Execution roadmap

## Order 10 — Repository Baseline & Green CI

**Priority:** P0  
**Phase:** Foundation  
**Code State:** Partial  
**Reuse Strategy:** Keep  
**Status:** Ready  
**Readiness:** Build Ready

### Goal
Establish a reproducible green baseline before any v4 migration.

### Required workflow

1. Record Node, pnpm and OS versions.
2. Start from a clean checkout/working tree.
3. Do not depend on zipped `node_modules`.
4. Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

5. Bring up required development infrastructure according to repo docs.
6. Validate safe Postgres migrations.
7. Validate safe ClickHouse migrations.
8. Verify Redis and Redpanda/Kafka where required.
9. Start API, consumer and web.
10. Verify health/readiness endpoints.
11. Verify at least one basic authenticated flow where practical.
12. Update README/deploy instructions only when demonstrably stale.

### Guardrails

- Never use production credentials.
- Never mutate production data.
- Do not combine with Canonical Context work.
- Do not delete failing tests.
- Fix only baseline blockers.
- Report architecture/product blockers instead of silently redesigning.

### Definition of Done

- clean install reproducible;
- typecheck green;
- build green;
- tests green, or remaining failure explicitly documented and task blocked;
- safe migrations reproducible;
- API/web/consumer startup reproducible;
- no unrelated v4 feature work.

**Do this first.**

---

## Order 20 — Live Data Truthfulness

**P0 · Refactor**

Dependency: Order 10.

Acceptance:

- demo may use synthetic data;
- live mode never silently falls back to mocks;
- standardized loading/error/empty/stale states;
- observable failures;
- regression tests.

---

## Order 25 — Environments, CI/CD & Release Foundation

**P0 · Adapt**

Adapt existing CI/deploy. Add only real gaps:

- environment strategy;
- protected merge checks;
- migration validation;
- feature flags;
- release/rollback procedure.

---

## Order 26 — Observability & Reliability Foundation

**P0 · Adapt**

Extend existing request IDs/logging/health infrastructure toward:

- connector/job/model metrics;
- queue lag;
- explicit retry/permanent failures;
- alert hooks;
- runbooks.

---

## Order 30 — Canonical Customer Context Model

**P0 · Adapt**

Additive model for Customer, Event, Trait/State, Relationship, Outcome and external IDs.

---

## Order 35 — Security, Privacy & Data Lifecycle Foundation

**P0 · Adapt**

Add missing lifecycle/privacy execution while preserving current security primitives.

---

## Order 40 — Truvo Events → Canonical Context Compatibility

**P0 · Adapt**

Preserve EventSchema, tracking, webhook events, dedup and source priority.

---

## Order 45 — Identity Graph v2

**P0 · Refactor**

Preserve v1 history/stitching and migrate to type-aware identifier uniqueness plus explicit conflict handling.

---

## Order 50 — Connector Framework

**P0 · Refactor**

Unify source/destination/bidirectional connector contracts and reuse current integration code.

---

## Order 55 — Privacy Erasure & Retention Execution

**P1 · Adapt**

Implement complete deletion/anonymization execution across applicable stores.

---

## Order 60 — Shopify Context Connector

**P0 · Adapt**

Expand existing Shopify webhook infrastructure into full context sync.

---

## Order 61 — HubSpot Context Connector

**P0 · Adapt**

Expand HubSpot context and fix batch webhook processing.

---

## Order 62 — Stripe Context Connector

**P0 · Adapt**

Expand Stripe billing events into durable customer/subscription context.

---

## Order 63 — Klaviyo Context & Activation Connector

**P0 · Build**

Build real source + destination connector.

---

## Order 70 — Event & Context Quality Engine

**P1 · Adapt**

Reuse legacy quality primitives and expose actionable Radar readiness.

---

## Order 80 — Create Radar v1

**P0 · Build**

Implement Radar configuration, readiness and persistence.

---

## Order 90 — Propensity Modeling v1

**P0 · Build**

Implement temporal labeled datasets, calibrated scoring and model evaluation.

---

## Order 95 — MLOps & Model Registry v1

**P1 · Build**

Persist and operationalize model lifecycle.

---

## Order 100 — Revenue Opportunities v1

**P0 · Build**

Create ranked customer opportunities and activation/export handoff.

---

## Order 110 — Decision & Action Logging

**P1 · Adapt**

Create canonical decision/outcome ledger.

---

## Order 120 — Onboarding & Workspace Setup v1

**P1 · Refactor**

Shift onboarding to:

```text
Connect Context → Validate Readiness → Create Radar
```

---

## Order 130 — QA Harness & Demo Workspace v1

**P0 · Adapt**

Add:

- versioned synthetic dataset;
- connector fixtures;
- tenant isolation;
- golden E2E:

```text
workspace → context → Radar → opportunity
```

---

## Order 140 — Truvo Product Analytics v1

**P1 · Build**

Measure onboarding, first context, first Radar, opportunities, activation and Time to First Value separately from customer business events.

---

## Order 150 — UX & App Shell v1

**P0 · Refactor**

Reuse current shell, refocus navigation and standardize loading/empty/error/permission/degraded states.

---

# 33. After the Radar MVP

Only after the MVP produces real outcome data prioritize:

1. Next Best Action v1;
2. Experimentation & Holdouts;
3. Uplift Modeling;
4. Incremental Revenue & Profit;
5. Contextual Decision Policy;
6. Autonomous Activation Guardrails.

Progression:

```text
Analytics
→ Recommendation
→ Assisted Activation
→ Experimentation
→ Causal Decisioning
→ Autonomous Revenue Engine
```

---

# 34. Engineering guardrails

## Preserve compatibility

Do not silently break:

- existing EventSchema clients;
- tracking API;
- webhook contracts;
- event deduplication;
- workspace isolation;
- identity history;
- attribution semantics still exposed to customers.

## Prefer additive migrations

1. add new structures;
2. backfill;
3. dual-read/dual-write when appropriate;
4. validate;
5. migrate consumers;
6. remove legacy paths only when proven safe.

## Do not duplicate subsystems

Before creating a new auth layer, workspace layer, credential store, job system, event queue, identity graph, notification system, audit system or reporting primitive, inspect the repository for an existing implementation and adapt it if viable.

## No silent semantic changes

Changes to event meaning, identity merge rules, customer semantics, attribution semantics, outcome definitions or score interpretation must be explicit and testable.

---

# 35. Required validation for every work item

As applicable:

```text
lint
typecheck
unit tests
integration tests
build
database migrations
startup/health checks
critical flow verification
```

A work item is not complete because code was written.

It is complete when its acceptance criteria are demonstrably satisfied.

---

# 36. Required Codex completion report

Use this format after every work item:

```markdown
## Work Item Completed
<name + execution order>

### Summary
What was implemented.

### Existing Code Reused
- ...

### Files Changed
- ...

### Migrations
- ...

### Tests / Validation
- command:
  result:

### Acceptance Criteria
- [x] ...
- [ ] ...

### Compatibility
What legacy behavior was preserved or intentionally migrated.

### Risks / Blockers
- ...

### Recommended Next Work Item
Execution Order XX — ...
```

If acceptance criteria are not satisfied, do **not** report the work item as Done.

---

# 37. Immediate instruction

Start with:

> **Execution Order 10 — Repository Baseline & Green CI**

Do not begin Order 20+ until the current repository has a reproducible green baseline or the remaining blocker has been explicitly reported.

After Order 10 is green, continue sequentially through this document.

---

# 38. Final product principle

Truvo evolves from:

```text
What happened?
```

to:

```text
What will happen?
```

to:

```text
What should we do?
```

and eventually:

```text
What action creates incremental revenue that would not have happened otherwise?
```

Preserve the strong measurement/data foundation already built while making **Radars and Revenue Opportunities** the center of the new product.

> **Do not rebuild Truvo. Evolve it.**
