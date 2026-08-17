import assert from 'node:assert/strict';
import test from 'node:test';
import { createKlaviyoAdapter } from './klaviyo.adapter';
import { KLAVIYO_API_REVISION, KLAVIYO_EVENT_OVERLAP_MS, KLAVIYO_PROVIDER } from './klaviyo.constants';

/**
 * Order 063 — pure unit tests (no DB, no real network), mirroring
 * `stripe.adapter.test.ts`'s style. Klaviyo declares no `webhook_ingest`
 * capability (see `klaviyo.adapter.ts`'s DEFINITION comment) so there is
 * deliberately no webhook verify/normalize test here — nothing to test, not a
 * skipped proof.
 */
process.env.KLAVIYO_CLIENT_ID ??= 'klaviyo_test_client_id';
process.env.KLAVIYO_CLIENT_SECRET ??= 'klaviyo_test_client_secret';
process.env.KLAVIYO_OAUTH_STATE_SECRET ??= 'klaviyo_connector_test_state_secret';

const connection = {
  workspaceId: 'ws_klaviyo',
  id: 'conn_klaviyo',
  provider: KLAVIYO_PROVIDER,
  role: 'bidirectional' as const,
  displayName: 'Klaviyo',
  lifecycleState: 'connected' as const,
  credentialStatus: 'valid' as const,
  config: { profile_properties: ['plan'], custom_event_metric_name: 'Truvo Activation' },
  capabilities: [],
  lastError: null,
  lastCredentialCheckAt: null,
  lastSyncAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const credentials = { access_token: 'test_access_token', refresh_token: 'test_refresh', klaviyo_account_id: 'acct_test' };

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null }, json: async () => body } as unknown as Response;
}

test('Klaviyo adapter sends the pinned revision header + Bearer auth on every request', async () => {
  const seenHeaders: Record<string, string>[] = [];
  const adapter = createKlaviyoAdapter((async (_url: string, init?: RequestInit) => {
    seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return response({ data: [], links: { next: null } });
  }) as typeof fetch);

  await adapter.initialBackfill!(connection, credentials, { streamKey: 'profiles', cursor: null, status: 'pending', processedCount: 0 });
  assert.ok(seenHeaders.length > 0);
  for (const h of seenHeaders) {
    assert.equal(h.revision, KLAVIYO_API_REVISION);
    assert.equal(h.Authorization, `Bearer ${credentials.access_token}`);
  }
});

test('Klaviyo adapter paginates + maps both the profiles and events streams', async () => {
  const adapter = createKlaviyoAdapter((async (url: string) => {
    if (url.includes('/api/profiles')) {
      return response({
        data: [
          {
            id: 'profile_1',
            attributes: {
              email: 'Buyer@Example.com',
              phone_number: '+55 11 99999-0000',
              properties: { plan: 'pro', internal_note: 'ignore me' },
              subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } }, sms: { marketing: { consent: 'UNSUBSCRIBED' } } },
              updated: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
        links: { next: null },
      });
    }
    if (url.includes('/api/events')) {
      return response({
        data: [
          {
            id: 'event_1',
            attributes: { datetime: '2026-01-02T00:00:00.000Z', event_properties: { $campaign: 'camp_1' } },
            relationships: { metric: { data: { id: 'metric_1' } }, profile: { data: { id: 'profile_1' } } },
          },
        ],
        included: [{ type: 'metric', id: 'metric_1', attributes: { name: 'Opened Email' } }],
        links: { next: null },
      });
    }
    return response({ data: [], links: { next: null } });
  }) as typeof fetch);

  const profiles = await adapter.initialBackfill!(connection, credentials, { streamKey: 'profiles', cursor: null, status: 'pending', processedCount: 0 });
  assert.equal(profiles.records.length, 1);
  const profile = profiles.records[0]!;
  assert.ok(profile.identifiers.some((i) => i.identifierType === 'external_id' && i.identifierValue === 'profile_1'));
  assert.ok(profile.identifiers.some((i) => i.identifierType === 'email_hash'));
  assert.ok(profile.traits?.some((t) => t.traitNamespace === 'klaviyo' && t.traitKey === 'plan' && t.value === 'pro'));
  assert.equal(profile.traits?.some((t) => t.traitKey === 'internal_note'), false, 'an unconfigured property must never become a trait');
  assert.ok(profile.traits?.some((t) => t.traitNamespace === 'messaging' && t.traitKey === 'email_marketing_consent' && t.value === 'SUBSCRIBED'));
  assert.ok(profile.traits?.some((t) => t.traitNamespace === 'messaging' && t.traitKey === 'sms_marketing_consent' && t.value === 'UNSUBSCRIBED'));

  const events = await adapter.initialBackfill!(connection, credentials, { streamKey: 'events', cursor: null, status: 'pending', processedCount: 0 });
  assert.equal(events.records.length, 1);
  const event = events.records[0]!;
  assert.equal(event.engagementEvent?.providerEventId, 'event_1');
  assert.equal(event.engagementEvent?.metricName, 'Opened Email');
  assert.equal(event.engagementEvent?.engagementKind, 'opened');
  assert.equal(event.engagementEvent?.campaignId, 'camp_1');
  assert.equal(event.engagementEvent?.correlationId, undefined, 'a generic engagement event must never fabricate correlation');
});

test('Klaviyo delayed-event-safe incremental cursor: events backs off by the bounded overlap window on catch-up; profiles advances to now', async () => {
  const adapter = createKlaviyoAdapter((async () => response({ data: [], links: { next: null } })) as typeof fetch);
  const before = Date.now();
  const eventsResult = await adapter.incrementalPull!(connection, credentials, { streamKey: 'events', cursor: null, status: 'pending', processedCount: 0 });
  const after = Date.now();
  const eventsCursorMs = Date.parse(eventsResult.nextCursor!);
  assert.ok(
    eventsCursorMs <= before - KLAVIYO_EVENT_OVERLAP_MS + 2000 && eventsCursorMs >= after - KLAVIYO_EVENT_OVERLAP_MS - 5000,
    'events incremental cursor must land ~15min behind now, not exactly now',
  );

  const profilesResult = await adapter.incrementalPull!(connection, credentials, { streamKey: 'profiles', cursor: null, status: 'pending', processedCount: 0 });
  const profilesCursorMs = Date.parse(profilesResult.nextCursor!);
  assert.ok(profilesCursorMs >= before && profilesCursorMs <= after + 2000, 'profiles incremental cursor must advance to now on catch-up (mutable state, safe to do so)');
});

test('Klaviyo rate limit classification carries Retry-After', async () => {
  const adapter = createKlaviyoAdapter((async () => response({}, 429, { 'retry-after': '7' })) as typeof fetch);
  await assert.rejects(
    () => adapter.initialBackfill!(connection, credentials, { streamKey: 'profiles', cursor: null, status: 'pending', processedCount: 0 }),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 429);
      assert.equal((err as { retryAfterMs?: number }).retryAfterMs, 7000);
      return true;
    },
  );
});

test('Klaviyo profile trait writeback rejects any non-allowlisted property (whole write refused)', async () => {
  const adapter = createKlaviyoAdapter((async () => response({ data: { id: 'profile_1' } })) as typeof fetch);

  const rejected = await adapter.write!(connection, credentials, {
    idempotencyKey: 'k1',
    correlationId: 'c1',
    kind: 'profile_upsert',
    payload: { profileId: 'profile_1', properties: { truvo_score_band: 'high', not_allowlisted: 'x' } },
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.retryable, false);
  assert.match(rejected.error ?? '', /not a namespaced Truvo-owned property/);

  const accepted = await adapter.write!(connection, credentials, {
    idempotencyKey: 'k2',
    correlationId: 'c2',
    kind: 'profile_upsert',
    payload: { profileId: 'profile_1', properties: { truvo_score_band: 'high' } },
  });
  assert.equal(accepted.status, 'sent');
  assert.equal(accepted.externalResultId, 'profile_1');
});

test('Klaviyo custom event write posts unique_id + correlation metadata, treats 202 as accepted (no externalResultId)', async () => {
  let capturedBody: { data: { attributes: { unique_id: string; metric: { data: { attributes: { name: string } } }; properties: Record<string, unknown> } } } | undefined;
  const adapter = createKlaviyoAdapter((async (url: string, init?: RequestInit) => {
    if (url.includes('/api/events')) {
      capturedBody = JSON.parse(init!.body as string);
      return response(undefined, 202);
    }
    return response({});
  }) as typeof fetch);

  const result = await adapter.write!(connection, credentials, {
    idempotencyKey: 'activation_123',
    correlationId: 'corr_123',
    kind: 'custom_event',
    payload: { customerId: 'cust_1', profileIdentifier: { email: 'buyer@example.com' }, metricName: 'Truvo Activation', properties: { activation_id: 'corr_123' } },
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.externalResultId, undefined, '202 accepted has no reliable provider-assigned id');
  assert.equal(capturedBody!.data.attributes.unique_id, 'activation_123');
  assert.equal(capturedBody!.data.attributes.metric.data.attributes.name, 'Truvo Activation');
  assert.equal(capturedBody!.data.attributes.properties.activation_id, 'corr_123');
});

test('Klaviyo OAuth PKCE: authorize URL carries an S256 challenge, exchange verifies signed state and rejects tampering', async () => {
  const adapter = createKlaviyoAdapter((async (url: string) => {
    if (url.includes('/oauth/token')) return response({ access_token: 'new_access', refresh_token: 'new_refresh', expires_in: 3600, token_type: 'Bearer' });
    if (url.includes('/api/accounts')) return response({ data: [{ id: 'acct_immutable' }] });
    return response({});
  }) as typeof fetch);

  const url = adapter.getOAuthAuthorizeUrl!(connection, 'https://truvo.test/callback').url;
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsed.searchParams.get('code_challenge'), 'a PKCE code_challenge must be present');
  assert.ok(parsed.searchParams.get('scope')?.includes('accounts:read'), 'accounts:read is mandatory on every grant');
  const state = parsed.searchParams.get('state')!;

  const exchanged = await adapter.exchangeOAuthCode!(connection, { code: 'ac_one_time', redirectUri: 'https://truvo.test/callback', state });
  assert.deepEqual(exchanged.connectionMetadata, { klaviyo_account_id: 'acct_immutable' });
  assert.equal((exchanged.credentials as { access_token: string }).access_token, 'new_access');

  await assert.rejects(() => adapter.exchangeOAuthCode!(connection, { code: 'x', redirectUri: 'https://truvo.test/callback', state: 'tampered' }));
});
