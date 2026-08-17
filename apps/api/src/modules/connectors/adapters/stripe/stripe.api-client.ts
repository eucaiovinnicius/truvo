import { STRIPE_API_BASE_URL, STRIPE_API_VERSION } from './stripe.constants';

export type StripeFetch = typeof fetch;
export interface StripeCredentials { connected_account_id: string; livemode?: boolean; webhook_secret: string; }

export class StripeApiClient {
  constructor(private readonly credentials: StripeCredentials, private readonly fetchImpl: StripeFetch = fetch) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const secret = process.env.STRIPE_SECRET_KEY ?? '';
    if (!secret || !this.credentials.connected_account_id) throw Object.assign(new Error('Stripe platform key or connected account missing'), { status: 401 });
    const response = await this.fetchImpl(`${STRIPE_API_BASE_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, 'Stripe-Account': this.credentials.connected_account_id, 'Stripe-Version': STRIPE_API_VERSION, ...(init.headers ?? {}) } });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`stripe authorization failure (${response.status})`), { status: response.status });
    if (response.status === 429) throw Object.assign(new Error('stripe rate limited'), { status: 429, retryAfterMs: Number(response.headers.get('retry-after') ?? 2) * 1000 });
    if (!response.ok) throw Object.assign(new Error(`stripe http error (${response.status})`), { status: response.status });
    return (await response.json()) as T;
  }
}
