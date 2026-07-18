import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * M1 — AUTH & WORKSPACES (PRD §7 M1, §8, §9).
 * Base multi-tenant: TODA tabela tem workspace_id e TODA query filtra por ele (regra 1).
 *
 * ── Onde a RLS do Supabase entra ─────────────────────────────────────────────
 * O backend (NestJS) usa a SERVICE_ROLE_KEY, que **bypassa RLS** — por isso o
 * isolamento é garantido na aplicação (WorkspaceGuard + `where workspace_id=...`).
 * A RLS abaixo é defesa-em-profundidade para queries diretas do FRONTEND com o
 * ANON key + JWT do usuário (`auth.uid()`). As policies vivem no Supabase e são
 * aplicadas via migration — ver `auth.rls.sql` neste diretório. Resumo:
 *   users              → SELECT/UPDATE só a própria linha (id = auth.uid()).
 *   workspaces         → SELECT/UPDATE só workspaces em que auth.uid() é membro.
 *   workspace_members  → pivot RLS: SELECT só linhas de workspaces do usuário;
 *                        INSERT/UPDATE/DELETE só por owner/admin do workspace.
 * `SUPABASE_SERVICE_ROLE_KEY` NUNCA vai ao frontend (regra 3).
 */

/** Papéis dentro de um workspace (PRD §7 M1 — tabela de permissões). */
export const workspaceRoleEnum = pgEnum('workspace_role', [
  'owner',
  'admin',
  'member',
  'viewer',
]);

/** Status de um membro no workspace (convite pendente vs. ativo). */
export const memberStatusEnum = pgEnum('workspace_member_status', ['active', 'invited']);

/**
 * users — projeção de aplicação do usuário. O ID é o MESMO de `auth.users.id`
 * do Supabase Auth (fonte de verdade de credenciais/sessão). Não criamos FK
 * cross-schema para `auth.users` no Drizzle; a integridade é garantida pelo
 * fluxo de signup/convite que sempre usa o id retornado pelo Supabase.
 *
 * Nota sobre regra 4 (email como SHA-256): a regra 4 é sobre PII em EVENTOS/
 * analytics (`email_hash`). Aqui é a camada de CONTA — o email é dado de auth
 * legítimo e já vive em plaintext em `auth.users`; espelhamos para display/
 * convites/lookup. PII analítica usa hash em outros módulos (M2/M4/M8).
 */
export const users = pgTable(
  'users',
  {
    // = auth.users.id (Supabase). Sem defaultRandom: o id vem do Supabase Auth.
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    fullName: text('full_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
);

/**
 * workspaces — tenant. Configurações do PRD §7 M1: nome, slug, logo, timezone,
 * moeda, retenção de dados. `slug` é único (usado em URLs / white-label).
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 63 }).notNull(),
    logoUrl: text('logo_url'),
    // IANA tz — resolve presets de date_range (PRD §6/M6). Default BR.
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    // ISO-4217. Moeda de exibição/relatórios do workspace.
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),
    // Retenção de dados em dias — padrão 24 meses (PRD §11). Expurgo automático.
    dataRetentionDays: integer('data_retention_days').notNull().default(730),
    // Criador (vira owner). FK para users.id.
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('workspaces_slug_unique').on(t.slug),
  }),
);

/**
 * workspace_members — PIVOT multi-tenant (RLS pivot, PRD §8). Liga user↔workspace
 * com um papel. É a tabela consultada pelo WorkspaceGuard para autorização.
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull().default('member'),
    status: memberStatusEnum('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Um usuário só pode ter UMA linha por workspace.
    memberUnique: uniqueIndex('workspace_members_ws_user_unique').on(t.workspaceId, t.userId),
    // Lookups quentes: por workspace (listar membros) e por usuário (listar workspaces).
    byWorkspace: index('workspace_members_workspace_idx').on(t.workspaceId),
    byUser: index('workspace_members_user_idx').on(t.userId),
  }),
);

// ── Relations (Drizzle relational queries) ──────────────────────────────────
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMembers),
}));

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  members: many(workspaceMembers),
  creator: one(users, {
    fields: [workspaces.createdBy],
    references: [users.id],
  }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userId],
    references: [users.id],
  }),
}));

// ── Tipos inferidos ─────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
