# ORDER 040 — TRUVO EVENTS → CANONICAL CONTEXT COMPATIBILITY

**Priority:** P0  
**Phase:** Foundation  
**Status:** Ready / Build Ready  
**Reuse:** Adapt mature EventSchema/event pipeline

## Goal

Preserve every current Truvo tracking/event contract while deterministically projecting approved event meaning into the Order 30 Canonical Customer Context.

Target flow:

`EventSchema → identity resolution → immutable event persistence → canonical trait/outcome projection → context update`

**Projection is additive. The original event remains the source record and keeps its existing semantics.**

## Preflight

Start from Order 35 closure:

`1d5aab7d9d20b1bcb17a8ab53d3f7691e908f504`

Inspect `git status` first and preserve user execution docs.

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

## Read

Always:
- `/AGENTS.md`
- this file
- `/docs/exec/HANDOFF_TEMPLATE.md`

Inspect first:
- `packages/event-schema/**`
- pixel `track()` / `identify()` implementation
- server-side event ingestion API
- event validation/dedup code
- consumer/batcher event processing
- webhook normalizers/producers
- identity resolution/stitching
- Order 30 `CustomerContextService`, outcomes and traits
- event source-priority rules
- existing replay/DLQ/error patterns

Do not preload unrelated roadmap sections.

## Compatibility invariants

Must remain backward compatible without client migration:

- normalized EventSchema
- pixel `track` and `identify`
- server-side event API
- normalized webhook-produced events
- event/source timestamps
- workspace, anonymous/user/session/click/order identifiers
- properties/context meaning
- custom/unknown event names
- `event_id` / `order_id` dedup and economic-event idempotency
- source priority
- existing ClickHouse event history and legacy analytics

Do not rename or mutate stored historical/raw event payloads.

## 1. Deterministic projection layer

Create a typed, testable mapping layer from accepted EventSchema events into canonical context effects.

Projection may produce only explicit effects such as:

- approved identifier attachment/resolution
- documented current trait/state updates
- canonical outcome completion/observation
- internal context-updated signal

Generic events such as `page_view` must **not** fabricate arbitrary traits.

Unknown/custom events remain valid events and may legitimately project nothing.

Keep the mapping registry/config explicit and reviewable; no hidden event-name heuristics.

## 2. Outcomes

Map known economic/lifecycle events to canonical outcomes without changing the original event name.

At minimum cover existing relevant semantics such as purchase/subscription where canonical outcome definitions exist.

Preserve current value/currency/order semantics and dedup behavior.

Do not create a second competing purchase truth.

## 3. Identify compatibility

Existing `identify()` must keep its accepted contract.

It may attach approved namespaced identifiers to canonical customer context through existing safe identity behavior and trigger existing retroactive stitching.

It must not rewrite prior raw ClickHouse event payloads.

Do not implement Identity Graph v2 here.

## 4. Failure / replay behavior

Underlying accepted event persistence must not be silently lost because canonical projection fails.

Projection failures must be:

- observable with reason/correlation/workspace
- retry/replay capable using existing queue/DLQ/reliability patterns where possible
- idempotent on replay
- unable to duplicate economic outcomes/traits

Do not introduce a parallel event pipeline.

## 5. Backward compatibility fixtures

Replay representative historical payloads from:

- pixel/browser
- server-side API
- normalized webhook producer(s)
- custom unknown event

Prove old ingestion/validation/dedup results remain unchanged while expected canonical side effects are added.

Include an end-to-end representative flow:

`click/anonymous → events → identify → purchase`

Assert it resolves to one canonical customer/outcome without mutating historical event payloads.

## Acceptance

- [ ] EventSchema unchanged/backward compatible
- [ ] pixel `track/identify` clients require no change
- [ ] server-side API/webhook producers require no change
- [ ] deterministic explicit projection registry/service exists
- [ ] only documented fields become traits/state
- [ ] purchase/subscription outcome projection preserves original semantics
- [ ] custom unknown event remains valid and safely projects nothing
- [ ] `event_id`/`order_id` dedup behavior unchanged
- [ ] source priority unchanged
- [ ] projection failure does not discard accepted event
- [ ] projection retry/replay is observable + idempotent
- [ ] anonymous→identify→purchase compatibility flow PASS
- [ ] representative historical payload replay tests PASS
- [ ] legacy analytics/event persistence behavior remains compatible
- [ ] `pnpm migration:validate` PASS if migrations change
- [ ] `pnpm lint` PASS
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS

## Out of scope

Do not implement:
- Identity Graph v2
- Connector Framework/new connectors
- broad EventSchema v2 redesign
- Radars/ML/NBA
- moving event history out of ClickHouse
- provider-specific canonical fields
- broad UI changes

Prefer adapters/projectors over invasive rewrites.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:
- event contracts preserved
- projection mappings added
- dedup/source-priority evidence
- failure/replay evidence
- historical payload fixtures
- anonymous→identify→purchase evidence
- migrations, if any
- exact final validation results
- compatibility risks discovered

Do not start the next Execution Order.

End with:

`TRUVO_CODEX_HANDOFF_END`
