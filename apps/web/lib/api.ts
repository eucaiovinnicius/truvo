const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    statusText: string,
  ) {
    super(`API ${status} ${statusText} em ${path}`);
    this.name = 'ApiError';
  }
}

/** Headers de auth (JWT do Supabase + workspace atual) a partir do localStorage. */
function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('truvo_token');
  const workspace = localStorage.getItem('truvo_workspace');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (workspace) headers['x-workspace-id'] = workspace;
  return headers;
}

/** Cliente HTTP tipado da API do Truvo. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, path, res.statusText);
  }
  const contentType = res.headers.get('content-type') ?? '';
  return (contentType.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export { BASE as API_BASE };
