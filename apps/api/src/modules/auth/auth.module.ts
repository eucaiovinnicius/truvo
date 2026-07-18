import { Global, Module } from '@nestjs/common';
import { supabaseProvider, SUPABASE_CLIENT } from './supabase.provider';
import { databaseProvider, DRIZZLE } from './database.provider';
import { AuthService } from './auth.service';
import { WorkspacesService } from './workspaces.service';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { WorkspacesController } from './workspaces.controller';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { WorkspaceGuard } from './guards/workspace.guard';

/**
 * M1 — AUTH & WORKSPACES. Base multi-tenant; tudo depende disto.
 *
 * @Global: os providers de infra (SUPABASE_CLIENT, DRIZZLE) e os guards
 * (SupabaseAuthGuard, WorkspaceGuard) ficam disponíveis para TODOS os módulos
 * (M2..M17) sem re-importar o AuthModule. Os módulos consomem via os caminhos
 * exatos: `../auth/guards/supabase-auth.guard`, `../auth/decorators`, etc.
 */
@Global()
@Module({
  controllers: [AuthController, UsersController, WorkspacesController],
  providers: [
    supabaseProvider,
    databaseProvider,
    AuthService,
    WorkspacesService,
    SupabaseAuthGuard,
    WorkspaceGuard,
  ],
  exports: [
    SUPABASE_CLIENT,
    DRIZZLE,
    AuthService,
    WorkspacesService,
    SupabaseAuthGuard,
    WorkspaceGuard,
  ],
})
export class AuthModule {}
