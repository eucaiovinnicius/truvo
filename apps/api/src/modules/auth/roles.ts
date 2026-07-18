/**
 * Papéis e permissões do M1 (PRD §7 M1 — tabela de permissões).
 * Centraliza a matriz para uso em guards, decorators e services.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Ranking para comparações (owner > admin > member > viewer). */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  viewer: 0,
};

export type Permission =
  | 'viewData'
  | 'createFunnelsDashboards'
  | 'manageIntegrations'
  | 'manageMembers'
  | 'billing'
  | 'deleteWorkspace';

/**
 * Matriz de permissões (PRD §7 M1):
 * | Ação                  | Owner | Admin | Member | Viewer |
 * | Ver dados             |  ✅   |  ✅   |  ✅    |  ✅    |
 * | Criar funis/dashboards|  ✅   |  ✅   |  ✅    |  ❌    |
 * | Gerenciar integrações |  ✅   |  ✅   |  ❌    |  ❌    |
 * | Gerenciar membros     |  ✅   |  ✅   |  ❌    |  ❌    |
 * | Billing               |  ✅   |  ❌   |  ❌    |  ❌    |
 * | Deletar workspace     |  ✅   |  ❌   |  ❌    |  ❌    |
 */
export const PERMISSIONS: Record<Permission, WorkspaceRole[]> = {
  viewData: ['owner', 'admin', 'member', 'viewer'],
  createFunnelsDashboards: ['owner', 'admin', 'member'],
  manageIntegrations: ['owner', 'admin'],
  manageMembers: ['owner', 'admin'],
  billing: ['owner'],
  deleteWorkspace: ['owner'],
};

/** Um `role` pode executar `action`? */
export function can(role: WorkspaceRole, action: Permission): boolean {
  return PERMISSIONS[action].includes(role);
}
