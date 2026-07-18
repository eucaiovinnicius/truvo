import type { Request } from 'express';

/** Usuário resolvido a partir do JWT do Supabase (M1 Auth). */
export interface AuthUser {
  id: string;
  email?: string;
}

/**
 * Request enriquecida pelos guards deste módulo.
 * - ApiKeyGuard  → seta `workspaceId` + `apiKeyId`.
 * - JwtAuthGuard → seta `user` + `workspaceId` (do header x-workspace-id).
 */
export interface AuthenticatedRequest extends Request {
  workspaceId: string;
  apiKeyId?: string;
  user?: AuthUser;
}
