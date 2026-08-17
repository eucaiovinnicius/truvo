// Barrel do schema Postgres (Drizzle). Cada módulo adiciona seu arquivo em schema/<módulo>.ts.
export * from './auth'; // M1 — users, workspaces, workspace_members
export * from './customer-context'; // Truvo 4.x - canonical customer context
export * from './customer-outcomes'; // Order 040 — observed outcomes (event→context projection)
export * from './identity-graph'; // Order 045 — identity conflicts + auditable/reversible merge events
export * from './connectors'; // Order 050 — provider-neutral Connector Framework
export * from './suppression'; // Order 055 — identity suppression against reconstruction
export * from './commerce'; // Order 060 — provider-neutral commerce (orders/line items/refunds)
export * from './billing-context'; // Order 062 — provider-neutral billing/subscription context
export * from './crm'; // Order 061 — provider-neutral CRM (accounts/deals/associations)
export * from './audit'; // Order 035 — audit_log (security/admin change trail)
export * from './data-lifecycle'; // Order 035 — data_lifecycle_requests (export/deletion orchestration)
export * from './events'; // M2 — api_keys
export * from './tracking'; // M3 — tracking_links
export * from './integrations'; // M4 — integrations, webhook_logs
export * from './identity'; // M8 — identity_links, identity_merges
export * from './data-quality'; // M14 — data_quality_settings, reconciliation_alerts
export * from './funnels'; // M5 — funnels
export * from './metrics'; // M6 — kpi_definitions, dashboards
export * from './attribution'; // M7 — attribution_settings
export * from './data-explorer'; // M16 — insights, insight_versions, insight_shares, explorer_catalog
export * from './profiles'; // M15 — user_profiles, profile_access_log
export * from './integrations-out'; // M9 — integration_out_configs, integration_out_logs
export * from './creatives'; // M10 — creatives, creative_ad_accounts, creative_alert_log
export * from './notifications'; // M12 — notifications, alert_rules, notification_preferences
export * from './billing'; // M11 — subscriptions, usage_records
export * from './reports'; // M13 — reports, report_runs
export * from './ai'; // M17 — ai_objectives, ai_journey_runs, ai_insights, ai_recommendations, ai_conversations
