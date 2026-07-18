import { OUTBOUND_HTTP_TIMEOUT_MS } from '../integrations-out.constants';

/**
 * Wrapper de fetch NATIVO (Node 20) com timeout via AbortController. Sem libs.
 * Nunca lança por status HTTP — devolve `{ ok, status, body }` e deixa o client
 * decidir. Lança apenas em erro de rede/timeout (o client encapsula em ok:false).
 */
export interface HttpJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // mantém texto cru quando não é JSON
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // mantém texto cru
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Mensagem de erro curta a partir de um body de resposta desconhecido. */
export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    // Meta: { error: { message } } · Google: { error: { message } } · TikTok: { message }
    const err = obj.error;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
    if (typeof obj.message === 'string' && obj.message) return obj.message;
  }
  if (typeof body === 'string' && body) return body.slice(0, 500);
  return fallback;
}
