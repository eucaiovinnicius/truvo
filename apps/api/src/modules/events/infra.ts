import { createDb, createClickHouse, type Database, type ClickHouseClient } from '@truvo/db';
import Redis from 'ioredis';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Clientes de infra memoizados (singletons de processo).
 *
 * Ficam em helpers de módulo — e não em providers com DI — de propósito: os
 * guards (ApiKeyGuard, RateLimitGuard, JwtAuthGuard) são importados por OUTROS
 * módulos e precisam funcionar sem arrastar o grafo de providers do EventsModule.
 * Sem estado injetado, `@UseGuards(ApiKeyGuard)` funciona em qualquer módulo.
 */

let _db: Database | undefined;
export function getDb(): Database {
  if (!_db) _db = createDb();
  return _db;
}

let _redis: Redis | undefined;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    _redis.on('error', (err: Error) => {
      // TODO(live): logger estruturado + alerta. Não derrubar o processo por blip do Redis.
      // eslint-disable-next-line no-console
      console.error(`[truvo/api] Redis error: ${err.message}`);
    });
  }
  return _redis;
}

let _ch: ClickHouseClient | undefined;
export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}

let _supabase: SupabaseClient | undefined;
/**
 * Client Supabase p/ validar o JWT do usuário (Auth do M1).
 * Usa a ANON key — o SERVICE_ROLE_KEY nunca sai do backend e não é usado aqui (regra 3).
 */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!url || !anon) {
      // TODO(live): configurar SUPABASE_URL/SUPABASE_ANON_KEY (ver .env.example).
      throw new Error('SUPABASE_URL/SUPABASE_ANON_KEY não configurados — ver .env.example');
    }
    _supabase = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

let _supabaseAdmin: SupabaseClient | undefined;
/**
 * Client Supabase com SERVICE_ROLE (contorna RLS) — SÓ no backend (regra 3), usado
 * para conferir membership em `workspace_members` (o client anon não leria a tabela
 * sob RLS). Cai para a anon se o service-role não estiver configurado.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!_supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados — ver .env.example');
    }
    _supabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabaseAdmin;
}
