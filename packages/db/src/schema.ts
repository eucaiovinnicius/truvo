import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Schema Postgres (Drizzle) — INICIAL / mínimo (Fase 0).
 * O Módulo 1 (Auth & Workspaces) expande com users, workspace_members,
 * api_keys, RLS, etc. (PRD §7 M1 e §8).
 */

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  currency: text('currency').notNull().default('BRL'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
