// Barrel do schema Postgres (Drizzle). Cada módulo adiciona seu arquivo em schema/<módulo>.ts.
export * from './auth'; // M1 — users, workspaces, workspace_members
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
