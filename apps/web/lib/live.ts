'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import {
  classifyLiveFailure,
  reconcileLiveContext,
  stateForContext,
  type LiveState,
} from './live-state';
import { useSession } from './session';

export type { LiveFailure, LiveState, LiveStatus } from './live-state';

/**
 * Busca `path` apenas em sessão live. O estado retornado distingue demo,
 * carregamento, sucesso e falha; dados de uma requisição anterior nunca são
 * mantidos quando path, modo ou workspace mudam.
 */
export function useLive<T = unknown>(path: string | null, deps: unknown[] = []): LiveState<T> {
  const { mode, workspace } = useSession();
  const workspaceId = workspace?.id;
  const active = mode === 'live' && !!path;
  const [state, setState] = useState<LiveState<T>>(() => stateForContext(mode, workspaceId, path));

  useEffect(() => {
    if (!active || !path) {
      setState(stateForContext(mode, workspaceId, path));
      return;
    }
    let alive = true;
    const loadingState = stateForContext<T>(mode, workspaceId, path);
    setState(loadingState);
    api<T>(path)
      .then((data) => {
        if (alive) {
          setState({
            data,
            loading: false,
            error: null,
            status: 'success',
            requestKey: loadingState.requestKey,
          });
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          const error = classifyLiveFailure(e, path);
          console.error('[live-data] request failed', {
            path: error.path,
            status: e instanceof ApiError ? e.status : undefined,
            kind: error.kind,
          });
          setState({
            data: null,
            loading: false,
            error,
            status: 'error',
            requestKey: loadingState.requestKey,
          });
        }
      });
    return () => {
      alive = false;
    };
    // deps intentionally let callers invalidate a stable path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, path, workspaceId, ...deps]);

  return reconcileLiveContext(state, mode, workspaceId, path);
}
