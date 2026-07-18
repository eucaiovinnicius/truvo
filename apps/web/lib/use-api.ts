'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Busca dados da API com estados de loading/erro. Enquanto a infra não subiu,
 * a falha vira `error` (a UI mostra um aviso, não quebra).
 */
export function useApi<T = unknown>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: !!path, error: null });

  useEffect(() => {
    if (!path) {
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
          setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'Falha na API' });
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  return state;
}
