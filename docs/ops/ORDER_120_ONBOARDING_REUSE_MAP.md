# Order 120 onboarding reuse map

| Classification | Area | Implementation decision |
|---|---|---|
| Keep / adapt | Auth and Workspaces | Existing production guards, membership context and workspace update service own access and basics. |
| Keep | Connector Framework | Existing connection rows, encrypted credentials, OAuth state, health and sync lifecycle remain authoritative. |
| Keep | Shopify, HubSpot, Stripe, Klaviyo | Onboarding only recommends and links existing adapter connections. |
| Keep | Customer Context and Identity Graph | Incoming-data verification queries canonical workspace-owned projections; no duplicate customer store. |
| Keep / adapt | Order 70 readiness | `EventContextQualityService` is invoked directly and its blockers/warnings are presented. |
| Keep / adapt | Order 80 Radar | `RadarService.create` remains the sole domain creation path; onboarding adds only a workspace lock and durable first-Radar idempotency. |
| Refactor | Legacy pixel-only onboarding | Simulated pixel, timers and fake Meta/Google success are replaced with server-owned state and real connector/event evidence. |
| New | Onboarding progress | One narrow workspace row stores resumable orchestration facts, not credentials or business payloads. |
| New | Onboarding milestones | A separate, idempotent internal telemetry table supports TTFV without entering customer EventSchema. |

The state machine is `not_started → in_progress → waiting_for_connection → syncing/waiting_for_data → data_detected → readiness_available → radar_in_progress → completed`, with `blocked` reconciled from current connector truth. A trained model or fabricated Opportunity is never required for completion.
