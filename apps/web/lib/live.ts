'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { useSession } from './session';

export interface LiveState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Busca `path` na API **apenas quando a sessão é 'live'**. Em modo demo (ou
 * `path === null`) não busca — o componente deve usar seus dados mock como
 * fallback (`live.data ?? MOCK`). Refaz a busca quando `deps` mudam.
 *
 * Enquanto a infra não sobe, a sessão fica em 'demo' e nada é buscado, então
 * as telas continuam com o visual/dados de exemplo intactos.
 */
export function useLive<T = unknown>(path: string | null, deps: unknown[] = []): LiveState<T> {
  const { isLive } = useSession();
  const active = isLive && !!path;
  const [state, setState] = useState<LiveState<T>>({ data: null, loading: active, error: null });

  useEffect(() => {
    if (!active || !path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path)
      .then((data) => {
        if (alive) setState({ data, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (alive) {
          setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'erro' });
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, path, ...deps]);

  return state;
}
