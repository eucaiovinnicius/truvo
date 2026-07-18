import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { SupabaseClient } from '@supabase/supabase-js';
import { users } from '@truvo/db';
import { DRIZZLE, type Database } from './database.provider';
import { SUPABASE_CLIENT } from './supabase.provider';
import { WorkspacesService } from './workspaces.service';
import type { LoginDto, RefreshDto, SignupDto } from './dto/auth.dto';
import type { UpdateUserDto } from './dto/user.dto';

/**
 * Auth (Supabase Auth) + perfil de usuário (PRD §7 M1).
 * A sessão (access/refresh token) vem do Supabase; o backend nunca guarda senha.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** POST /v1/auth/signup — cria usuário no Supabase + workspace default (owner). */
  async signup(dto: SignupDto) {
    const email = dto.email.toLowerCase();
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password: dto.password,
      options: { data: { full_name: dto.name ?? null } },
    });
    if (error) throw new BadRequestException(error.message);
    const authUser = data.user;
    if (!authUser) throw new BadRequestException('falha ao criar usuário');

    // Espelha em public.users (idempotente).
    await this.db
      .insert(users)
      .values({ id: authUser.id, email, fullName: dto.name ?? null })
      .onConflictDoUpdate({
        target: users.id,
        set: { email, updatedAt: new Date() },
      });

    // Workspace inicial — o usuário vira owner (base multi-tenant).
    const workspace = await this.workspaces.createWorkspace(authUser.id, {
      name: dto.name ? `${dto.name} Workspace` : 'Meu Workspace',
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      data_retention_days: 730,
    });

    return {
      user: { id: authUser.id, email, name: dto.name ?? null },
      // session pode ser null se o Supabase exigir confirmação de email.
      session: data.session,
      workspace,
    };
  }

  /** POST /v1/auth/login — retorna sessão (access + refresh token). */
  async login(dto: LoginDto) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: dto.email.toLowerCase(),
      password: dto.password,
    });
    if (error || !data.session || !data.user) {
      throw new UnauthorizedException('credenciais inválidas');
    }

    // Garante o espelho public.users (usuários criados antes deste módulo).
    await this.db
      .insert(users)
      .values({ id: data.user.id, email: data.user.email ?? dto.email.toLowerCase() })
      .onConflictDoNothing({ target: users.id });

    return {
      user: { id: data.user.id, email: data.user.email },
      session: data.session,
    };
  }

  /** POST /v1/auth/logout — revoga os refresh tokens do usuário no Supabase. */
  async logout(accessToken: string) {
    const { error } = await this.supabase.auth.admin.signOut(accessToken);
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  /** POST /v1/auth/refresh — troca refresh token por nova sessão. */
  async refresh(dto: RefreshDto) {
    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: dto.refresh_token,
    });
    if (error || !data.session) {
      throw new UnauthorizedException('refresh token inválido ou expirado');
    }
    return {
      session: data.session,
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
    };
  }

  /** GET /v1/users/me — perfil + workspaces do usuário. */
  async getMe(userId: string) {
    const [profile] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!profile) throw new NotFoundException('usuário não encontrado');

    const workspaces = await this.workspaces.listForUser(userId);
    return {
      id: profile.id,
      email: profile.email,
      name: profile.fullName,
      avatar_url: profile.avatarUrl,
      created_at: profile.createdAt,
      workspaces,
    };
  }

  /** PATCH /v1/users/me — atualiza nome/avatar (+ metadata no Supabase Auth). */
  async updateMe(userId: string, dto: UpdateUserDto) {
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.fullName = dto.name;
    if (dto.avatar_url !== undefined) patch.avatarUrl = dto.avatar_url;

    const [updated] = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new NotFoundException('usuário não encontrado');

    // Espelha o nome no user_metadata do Supabase (best-effort, não bloqueia).
    if (dto.name !== undefined) {
      await this.supabase.auth.admin.updateUserById(userId, {
        user_metadata: { full_name: dto.name },
      });
    }

    return {
      id: updated.id,
      email: updated.email,
      name: updated.fullName,
      avatar_url: updated.avatarUrl,
    };
  }
}
