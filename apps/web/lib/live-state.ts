import type { SessionMode } from './session';

export type LiveStatus = 'idle' | 'demo' | 'loading' | 'success' | 'error';
export type LiveFailureKind = 'auth' | 'permission' | 'unavailable';

export interface LiveFailure {
  kind: LiveFailureKind;
  message: string;
  path: string;
  status?: number;
  code?: string;
}

export interface LiveState<T> {
  data: T | null;
  loading: boolean;
  error: LiveFailure | null;
  status: LiveStatus;
  requestKey: string;
}

export function liveRequestKey(
  mode: SessionMode | null,
  workspaceId: string | undefined,
  path: string | null,
): string {
  return `${mode ?? 'none'}:${workspaceId ?? 'none'}:${path ?? 'none'}`;
}

export function stateForContext<T>(
  mode: SessionMode | null,
  workspaceId: string | undefined,
  path: string | null,
): LiveState<T> {
  const requestKey = liveRequestKey(mode, workspaceId, path);
  if (mode === 'demo') return { data: null, loading: false, error: null, status: 'demo', requestKey };
  if (mode === 'live' && path) {
    return { data: null, loading: true, error: null, status: 'loading', requestKey };
  }
  return { data: null, loading: false, error: null, status: 'idle', requestKey };
}

export function classifyLiveFailure(error: unknown, path: string): LiveFailure {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const kind: LiveFailureKind = status === 401 ? 'auth' : status === 403 ? 'permission' : 'unavailable';
  const message =
    kind === 'auth'
      ? 'Sua sessão expirou. Entre novamente para continuar.'
      : kind === 'permission'
        ? 'Você não tem permissão para acessar estes dados.'
        : 'Os dados ao vivo estão indisponíveis no momento. Tente novamente mais tarde.';
  const safePath = path.split('?')[0] ?? path;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : undefined;
  return { kind, message, path: safePath, ...(Number.isFinite(status) ? { status } : {}), ...(code ? { code } : {}) };
}

export function reconcileLiveContext<T>(
  state: LiveState<T>,
  mode: SessionMode | null,
  workspaceId: string | undefined,
  path: string | null,
): LiveState<T> {
  return state.requestKey === liveRequestKey(mode, workspaceId, path)
    ? state
    : stateForContext(mode, workspaceId, path);
}

export function selectLiveData<T, R>(
  state: LiveState<T>,
  demoData: R,
  emptyData: R,
  adapt: (data: T) => R,
): R {
  if (state.status === 'demo') return demoData;
  if (state.status === 'success' && state.data !== null) return adapt(state.data);
  return emptyData;
}

export type LiveSurface = 'content' | 'loading' | 'empty' | 'error' | 'permission' | 'auth';

export function resolveLiveSurface(states: LiveState<unknown>[], empty: boolean): LiveSurface {
  if (states.length === 0 || states.every((state) => state.status === 'demo')) return 'content';
  if (states.every((state) => state.status === 'idle')) return empty ? 'empty' : 'content';
  const failures = states.flatMap((state) => (state.status === 'error' && state.error ? [state.error] : []));
  if (failures.some((failure) => failure.kind === 'auth')) return 'auth';
  if (failures.some((failure) => failure.kind === 'permission')) return 'permission';
  if (failures.length > 0) return 'error';
  if (states.some((state) => state.status === 'loading')) return 'loading';
  return empty ? 'empty' : 'content';
}
