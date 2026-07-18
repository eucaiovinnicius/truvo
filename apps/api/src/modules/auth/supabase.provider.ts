import type { Provider } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente Supabase (Auth + Postgres) com SERVICE_ROLE — uso EXCLUSIVO no backend.
 * A service role bypassa RLS; por isso o isolamento multi-tenant é reforçado na
 * aplicação (WorkspaceGuard + filtro workspace_id — regra 1).
 *
 * regra 3: SUPABASE_SERVICE_ROLE_KEY NUNCA vai ao frontend — lida só do env aqui.
 */
export const SUPABASE_CLIENT = Symbol('SUPABASE_CLIENT');

export const supabaseProvider: Provider = {
  provide: SUPABASE_CLIENT,
  useFactory: (): SupabaseClient => {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // TODO(live): exige projeto Supabase no ar + chaves no .env (ver .env.example).
    if (!url || !serviceRoleKey) {
      throw new Error(
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas — ver .env.example (regra 3: service role só no backend)',
      );
    }
    return createClient(url, serviceRoleKey, {
      auth: {
        // Backend stateless: não persistir nem auto-refrescar sessão do processo.
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  },
};
