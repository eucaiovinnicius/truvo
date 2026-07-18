import { z } from 'zod';

/**
 * POST /v1/workspaces/:id/invite
 * `owner` não é convidável — há exatamente um dono (o criador); transferência
 * de posse é feita via PATCH member (regra de negócio do M1).
 */
export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
export type InviteDto = z.infer<typeof inviteSchema>;

/** PATCH /v1/workspaces/:id/members/:userId */
export const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;
