# Operational log privacy and retention

Repository-owned policy enforced by `RetentionEnforcementService`:

| Store | Retention | Stored data and erasure behavior |
|---|---:|---|
| `profile_access_log` | 730 days | Audit actor remains; a subject erasure replaces `canonical_id` with `[erased]` and metadata with `{subjectErased:true}`. |
| `integration_out_logs` | 180 days | Event/status/platform/match-key presence only; no raw match values, credentials, email, phone or IP. |
| `webhook_logs` | 30 days | Provider/status/safe summary. Terminal retry bodies are cleared eagerly; signatures, tokens and raw request bodies are never persisted. |

Enforcement is workspace-scoped, limited to 500 rows per statement, resumable,
idempotent and audited through the existing Order 35/55 lifecycle. Decision,
execution, exposure and reward provenance follows its separate Order 110 erasure
policy: retained facts become non-identifying rather than being fabricated or lost.
