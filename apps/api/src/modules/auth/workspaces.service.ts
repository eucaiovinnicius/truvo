import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SupabaseClient } from '@supabase/supabase-js';
import { users, workspaceMembers, workspaces } from '@truvo/db';
import { DRIZZLE, type Database } from './database.provider';
import { SUPABASE_CLIENT } from './supabase.provider';
import { AuditService } from '../audit/audit.service';
import type { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import type { InviteDto, UpdateMemberDto } from './dto/member.dto';
import type { WorkspaceRole } from './roles';

export interface ActingUser {
  id: string;
  email?: string;
}

/**
 * Workspaces + membros (PRD §7 M1). Todo acesso é escopado por workspace_id
 * (regra 1); a autorização por papel é feita no WorkspaceGuard (@Roles) e as
 * invariantes de posse (>=1 owner) são garantidas aqui.
 *
 * Mudanças de membership/papel e a remoção do workspace são operações auditáveis
 * (Order 035 §4) — reusa `AuditService` (@Global), best-effort, nunca derruba a
 * operação primária.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly audit: AuditService,
  ) {}

  /** Cria workspace + membership de owner atomicamente. */
  async createWorkspace(ownerId: string, dto: CreateWorkspaceDto) {
    const slug = await this.resolveUniqueSlug(dto.slug ?? this.slugify(dto.name));

    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({
          name: dto.name,
          slug,
          logoUrl: dto.logo_url ?? null,
          timezone: dto.timezone,
          currency: dto.currency,
          dataRetentionDays: dto.data_retention_days,
          createdBy: ownerId,
        })
        .returning();

      await tx.insert(workspaceMembers).values({
        workspaceId: ws.id,
        userId: ownerId,
        role: 'owner',
        status: 'active',
      });

      return { ...ws, role: 'owner' as WorkspaceRole };
    });
  }

  /** Lista os workspaces do usuário com seu papel em cada um. */
  async listForUser(userId: string) {
    return this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        logoUrl: workspaces.logoUrl,
        timezone: workspaces.timezone,
        currency: workspaces.currency,
        dataRetentionDays: workspaces.dataRetentionDays,
        role: workspaceMembers.role,
        status: workspaceMembers.status,
        createdAt: workspaces.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId));
  }

  /** Um workspace por id (o WorkspaceGuard já garantiu membership). */
  async getById(workspaceId: string) {
    const [ws] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) throw new NotFoundException('workspace não encontrado');
    return ws;
  }

  async update(workspaceId: string, dto: UpdateWorkspaceDto) {
    const patch: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.logo_url !== undefined) patch.logoUrl = dto.logo_url;
    if (dto.timezone !== undefined) patch.timezone = dto.timezone;
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.data_retention_days !== undefined) patch.dataRetentionDays = dto.data_retention_days;
    if (dto.slug !== undefined) {
      const taken = await this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, dto.slug))
        .limit(1);
      if (taken[0] && taken[0].id !== workspaceId) {
        throw new ConflictException('slug já está em uso');
      }
      patch.slug = dto.slug;
    }

    const [ws] = await this.db
      .update(workspaces)
      .set(patch)
      .where(eq(workspaces.id, workspaceId))
      .returning();
    if (!ws) throw new NotFoundException('workspace não encontrado');
    return ws;
  }

  /** Deleta workspace (cascade nos membros). Somente owner (@Roles no controller).
   * Operação destrutiva → auditada (Order 035 §4). Para o fluxo retry-safe de
   * tombstone da customer-context canônica antes da remoção, ver
   * `POST /v1/workspaces/:id/data-lifecycle/delete` (DataLifecycleController). */
  async remove(workspaceId: string, actor: ActingUser) {
    await this.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await this.audit.record({
      workspaceId,
      category: 'admin_config',
      action: 'workspace.removed',
      resourceType: 'workspace',
      resourceId: workspaceId,
      actorUserId: actor.id,
      actorEmail: actor.email,
    });
    return { success: true };
  }

  /** Membros do workspace com dados de perfil. */
  async listMembers(workspaceId: string) {
    return this.db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        status: workspaceMembers.status,
        email: users.email,
        name: users.fullName,
        avatarUrl: users.avatarUrl,
        createdAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
  }

  /**
   * Convida um membro por email (PRD §7 M1). Cria/recupera o usuário no Supabase
   * Auth (dispara email de convite) e cria a linha de membership.
   */
  async invite(workspaceId: string, invitedBy: string, dto: InviteDto) {
    const email = dto.email.toLowerCase();
    let targetUserId: string;
    let freshlyInvited = false;

    // TODO(live): inviteUserByEmail exige SMTP/templates configurados no Supabase.
    const invite = await this.supabase.auth.admin.inviteUserByEmail(email);
    if (invite.error || !invite.data?.user) {
      // Usuário provavelmente já existe no Auth -> usa o espelho public.users.
      const [existing] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!existing) {
        throw new BadRequestException(
          invite.error?.message ?? 'não foi possível convidar este email',
        );
      }
      targetUserId = existing.id;
    } else {
      targetUserId = invite.data.user.id;
      freshlyInvited = true;
      await this.db
        .insert(users)
        .values({ id: targetUserId, email })
        .onConflictDoNothing({ target: users.id });
    }

    const [already] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);
    if (already) throw new ConflictException('usuário já é membro deste workspace');

    const [member] = await this.db
      .insert(workspaceMembers)
      .values({
        workspaceId,
        userId: targetUserId,
        role: dto.role,
        status: freshlyInvited ? 'invited' : 'active',
        invitedBy,
      })
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'membership',
      action: 'membership.invited',
      resourceType: 'workspace_member',
      resourceId: targetUserId,
      actorUserId: invitedBy,
      metadata: { role: dto.role, freshly_invited: freshlyInvited },
    });

    return member;
  }

  /** Altera o papel de um membro. Preserva a invariante de >=1 owner. */
  async updateMember(workspaceId: string, targetUserId: string, dto: UpdateMemberDto, actor: ActingUser) {
    const target = await this.getMembership(workspaceId, targetUserId);
    if (target.role === 'owner' && dto.role !== 'owner') {
      await this.assertNotLastOwner(workspaceId);
    }

    const [updated] = await this.db
      .update(workspaceMembers)
      .set({ role: dto.role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'membership',
      action: 'membership.role_changed',
      resourceType: 'workspace_member',
      resourceId: targetUserId,
      actorUserId: actor.id,
      actorEmail: actor.email,
      metadata: { from_role: target.role, to_role: dto.role },
    });

    return updated;
  }

  /** Remove um membro. Não permite remover o único owner. */
  async removeMember(workspaceId: string, targetUserId: string, actor: ActingUser) {
    const target = await this.getMembership(workspaceId, targetUserId);
    if (target.role === 'owner') {
      await this.assertNotLastOwner(workspaceId);
    }

    await this.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      );

    await this.audit.record({
      workspaceId,
      category: 'membership',
      action: 'membership.removed',
      resourceType: 'workspace_member',
      resourceId: targetUserId,
      actorUserId: actor.id,
      actorEmail: actor.email,
      metadata: { removed_role: target.role },
    });

    return { success: true };
  }

  // -- internos ----------------------------------------------------------------

  private async getMembership(workspaceId: string, userId: string) {
    const [member] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (!member) throw new NotFoundException('membro não encontrado neste workspace');
    return member;
  }

  private async assertNotLastOwner(workspaceId: string) {
    const owners = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
      );
    if (owners.length <= 1) {
      throw new BadRequestException('o workspace precisa manter ao menos um owner');
    }
  }

  /** Normaliza um texto em slug URL-safe (remove acentos via categoria Mark). */
  private slugify(input: string): string {
    const base = input
      .normalize('NFKD')
      .replace(/\p{M}/gu, '') // remove marcas combinantes (acentos)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return base.length >= 2 ? base : 'workspace';
  }

  /** Garante unicidade do slug; anexa sufixo curto (crypto) em caso de colisão. */
  private async resolveUniqueSlug(desired: string): Promise<string> {
    let candidate = desired;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [hit] = await this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, candidate))
        .limit(1);
      if (!hit) return candidate;
      candidate = `${desired}-${randomBytes(4).toString('hex').slice(0, 6)}`.slice(0, 63);
    }
    // Fallback improvável: sufixo maior.
    return `${desired}-${randomBytes(8).toString('hex')}`.slice(0, 63);
  }
}
