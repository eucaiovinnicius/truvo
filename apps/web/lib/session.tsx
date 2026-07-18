'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';

/**
 * Sessão da web (auth real Supabase via API + modo demo).
 *
 * - `mode === null`  → não autenticado (mostra o login)
 * - `mode === 'live'`→ autenticado de verdade (token + workspace reais)
 * - `mode === 'demo'`→ modo demonstração (telas usam os dados mock de data.ts)
 *
 * O token/workspace ficam no localStorage nas chaves que o `api.ts` lê
 * (`truvo_token`, `truvo_workspace`), então toda chamada autenticada já
 * vai com `Authorization: Bearer` + `x-workspace-id`.
 */

export type SessionMode = 'demo' | 'live';

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  [k: string]: unknown;
}

export interface AuthResult {
  ok: boolean;
  reason?: 'invalid' | 'offline' | 'confirm';
}

interface SessionState {
  ready: boolean;
  mode: SessionMode | null;
  user: SessionUser | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  isLive: boolean;
  login: (email: string, password: string) => Promise<AuthResult>;
  signup: (email: string, password: string, name?: string) => Promise<AuthResult>;
  demo: () => void;
  logout: () => void;
}

const TOKEN_KEY = 'truvo_token';
const WS_KEY = 'truvo_workspace';
const MODE_KEY = 'truvo_mode';
const USER_KEY = 'truvo_user';

const SessionCtx = createContext<SessionState | null>(null);

interface LoginResponse {
  user: SessionUser;
  session: { access_token: string; refresh_token: string } | null;
}
interface SignupResponse extends LoginResponse {
  workspace?: Workspace | null;
}
interface MeResponse {
  id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  workspaces: Workspace[];
}

/** 401/403 → credenciais; qualquer outra falha (rede, 5xx) → offline. */
function classifyError(e: unknown): 'invalid' | 'offline' {
  const msg = e instanceof Error ? e.message : '';
  return /\b40[13]\b/.test(msg) ? 'invalid' : 'offline';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  // Hidrata a sessão salva (client-only).
  useEffect(() => {
    try {
      const savedMode = localStorage.getItem(MODE_KEY) as SessionMode | null;
      if (savedMode === 'live' || savedMode === 'demo') setMode(savedMode);
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedUser) setUser(JSON.parse(savedUser) as SessionUser);
      const wid = localStorage.getItem(WS_KEY);
      if (wid) setWorkspace({ id: wid, name: '' });
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  /** Guarda token, resolve workspace via /v1/users/me e marca sessão como live. */
  const finishLive = useCallback(async (accessToken: string, fallbackUser: SessionUser) => {
    localStorage.setItem(TOKEN_KEY, accessToken);
    let resolvedUser = fallbackUser;
    try {
      const me = await api<MeResponse>('/v1/users/me');
      resolvedUser = { id: me.id, email: me.email, name: me.name, avatar_url: me.avatar_url };
      const list = me.workspaces ?? [];
      setWorkspaces(list);
      const ws = list[0];
      if (ws) {
        localStorage.setItem(WS_KEY, ws.id);
        setWorkspace(ws);
      }
    } catch {
      /* sem /me (ex.: sem workspace ainda) — segue só com o token */
    }
    setUser(resolvedUser);
    localStorage.setItem(USER_KEY, JSON.stringify(resolvedUser));
    setMode('live');
    localStorage.setItem(MODE_KEY, 'live');
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      try {
        const res = await api<LoginResponse>('/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        if (!res.session) return { ok: false, reason: 'invalid' };
        await finishLive(res.session.access_token, res.user);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: classifyError(e) };
      }
    },
    [finishLive],
  );

  const signup = useCallback(
    async (email: string, password: string, name?: string): Promise<AuthResult> => {
      try {
        const res = await api<SignupResponse>('/v1/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ email, password, name }),
        });
        // Supabase pode exigir confirmação de e-mail (session null).
        if (!res.session) return { ok: false, reason: 'confirm' };
        if (res.workspace?.id) {
          localStorage.setItem(WS_KEY, res.workspace.id);
          setWorkspace(res.workspace);
          setWorkspaces([res.workspace]);
        }
        await finishLive(res.session.access_token, res.user);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: classifyError(e) };
      }
    },
    [finishLive],
  );

  const demo = useCallback(() => {
    setMode('demo');
    setUser({ id: 'demo', email: 'demo@truvo.ai', name: 'Demonstração' });
    localStorage.setItem(MODE_KEY, 'demo');
    localStorage.removeItem(TOKEN_KEY);
  }, []);

  const logout = useCallback(() => {
    [TOKEN_KEY, WS_KEY, MODE_KEY, USER_KEY].forEach((k) => localStorage.removeItem(k));
    setMode(null);
    setUser(null);
    setWorkspace(null);
    setWorkspaces([]);
  }, []);

  const value: SessionState = {
    ready,
    mode,
    user,
    workspace,
    workspaces,
    isLive: mode === 'live',
    login,
    signup,
    demo,
    logout,
  };

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession precisa estar dentro de <SessionProvider>');
  return ctx;
}
