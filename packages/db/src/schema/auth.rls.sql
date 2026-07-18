-- ─────────────────────────────────────────────────────────────────────────────
-- M1 — AUTH & WORKSPACES — Row Level Security (Supabase / Postgres)
-- Aplicar no Supabase APÓS as migrations do Drizzle criarem as tabelas.
-- (drizzle-orm 0.32.x não emite policies; este arquivo é a fonte da RLS.)
--
-- POR QUE: o backend NestJS usa SERVICE_ROLE_KEY e BYPASSA RLS — o isolamento
-- em runtime é feito na aplicação (WorkspaceGuard + filtro workspace_id, regra 1).
-- Esta RLS é defesa-em-profundidade para acesso DIRETO do frontend (anon key +
-- JWT do usuário), onde `auth.uid()` = id do usuário logado.
-- SUPABASE_SERVICE_ROLE_KEY nunca vai ao frontend (regra 3).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.users             enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

-- Helper: workspaces em que o usuário atual é membro.
create or replace function public.current_user_workspace_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from public.workspace_members where user_id = auth.uid();
$$;

-- Helper: papel do usuário atual num workspace.
create or replace function public.current_user_role(ws uuid)
returns public.workspace_role
language sql stable security definer set search_path = public as $$
  select role from public.workspace_members
  where user_id = auth.uid() and workspace_id = ws limit 1;
$$;

-- ── users ────────────────────────────────────────────────────────────────────
create policy users_select_self on public.users
  for select using (id = auth.uid());
create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ── workspaces ────────────────────────────────────────────────────────────────
create policy workspaces_select_member on public.workspaces
  for select using (id in (select public.current_user_workspace_ids()));
-- Alterar config: owner/admin (PRD §7 M1 — gerenciar workspace).
create policy workspaces_update_admin on public.workspaces
  for update using (public.current_user_role(id) in ('owner','admin'));
-- Deletar: só owner (PRD §7 M1).
create policy workspaces_delete_owner on public.workspaces
  for delete using (public.current_user_role(id) = 'owner');

-- ── workspace_members (pivot) ────────────────────────────────────────────────
-- Ver membros dos meus workspaces.
create policy members_select_same_ws on public.workspace_members
  for select using (workspace_id in (select public.current_user_workspace_ids()));
-- Gerenciar membros: owner/admin (PRD §7 M1 — gerenciar membros).
create policy members_write_admin on public.workspace_members
  for all
  using (public.current_user_role(workspace_id) in ('owner','admin'))
  with check (public.current_user_role(workspace_id) in ('owner','admin'));
