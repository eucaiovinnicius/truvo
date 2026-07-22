import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TruvoEvent } from '@truvo/event-schema';
import { detectBot } from './bot-filter';

/** Constrói um TruvoEvent mínimo para os testes (campos irrelevantes omitidos). */
function ev(source: TruvoEvent['source'], userAgent?: string): TruvoEvent {
  return {
    event_id: 'e1',
    event_name: 'page_view',
    source,
    workspace_id: 'ws',
    properties: {},
    context: userAgent === undefined ? {} : { user_agent: userAgent },
  } as TruvoEvent;
}

test('UA de humano (Chrome) → não é bot', () => {
  assert.equal(
    detectBot(ev('pixel', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')),
    false,
  );
});

test('UAs de bots conhecidos → bot', () => {
  const bots = [
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'facebookexternalhit/1.1',
    'python-requests/2.31.0',
    'curl/8.4.0',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
    'HeadlessChrome/125.0.0.0',
    'node-fetch/1.0',
  ];
  for (const ua of bots) assert.equal(detectBot(ev('pixel', ua)), true, ua);
});

test('UA vazio no PIXEL → bot (tráfego de browser sem UA é suspeito)', () => {
  assert.equal(detectBot(ev('pixel', '')), true);
  assert.equal(detectBot(ev('pixel')), true); // context sem user_agent
});

test('UA vazio em fonte SERVER-SIDE (webhook/api) → NÃO é bot', () => {
  assert.equal(detectBot(ev('webhook')), false);
  assert.equal(detectBot(ev('api')), false);
});

test('UA trivial (mozilla/5.0 sem detalhes) → bot', () => {
  assert.equal(detectBot(ev('pixel', 'Mozilla/5.0')), true);
  assert.equal(detectBot(ev('pixel', '-')), true);
});
