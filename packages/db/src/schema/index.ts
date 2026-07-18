// Barrel do schema Postgres (Drizzle). Cada módulo adiciona seu arquivo em schema/<módulo>.ts.
export * from './auth'; // M1 — users, workspaces, workspace_members
export * from './events'; // M2 — api_keys
export * from './tracking'; // M3 — tracking_links
export * from './integrations'; // M4 — integrations, webhook_logs
