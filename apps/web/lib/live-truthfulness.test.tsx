import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveDataBoundary } from './live-ui';
import {
  classifyLiveFailure,
  reconcileLiveContext,
  resolveLiveSurface,
  selectLiveData,
  stateForContext,
  type LiveState,
} from './live-state';

function success<T>(data: T, workspace = 'workspace-a'): LiveState<T> {
  return {
    data,
    loading: false,
    error: null,
    status: 'success',
    requestKey: `live:${workspace}:/resource`,
  };
}

function failure(): LiveState<unknown> {
  return {
    data: null,
    loading: false,
    error: classifyLiveFailure({ status: 503 }, '/resource'),
    status: 'error',
    requestKey: 'live:workspace-a:/resource',
  };
}

test('live success exposes only adapted API values', () => {
  const state = success({ rows: [{ id: 'real-row' }] });
  assert.deepEqual(
    selectLiveData(state, [{ id: 'demo-row' }], [], (data) => data.rows),
    [{ id: 'real-row' }],
  );
});

test('live failure never selects demo data and renders an observable error', () => {
  const state = failure();
  const selected = selectLiveData(state, ['SILENT_MOCK_VALUE'], [], (data) => [data]);
  assert.deepEqual(selected, []);
  const html = renderToStaticMarkup(
    <LiveDataBoundary states={[state]} empty={false} label="Teste">
      <span>SILENT_MOCK_VALUE</span>
    </LiveDataBoundary>,
  );
  assert.match(html, /data-live-state="error"/);
  assert.match(html, /Dados ao vivo indisponíveis/);
  assert.doesNotMatch(html, /SILENT_MOCK_VALUE/);
});

test('successful empty response remains empty and uses the empty surface', () => {
  const state = success<string[]>([]);
  assert.deepEqual(selectLiveData(state, ['demo'], [], (data) => data), []);
  assert.equal(resolveLiveSurface([state], true), 'empty');
});

test('demo mode deterministically selects synthetic demo data', () => {
  const state = stateForContext<unknown>('demo', undefined, '/resource');
  const demo = [{ id: 'demo-row' }];
  assert.strictEqual(selectLiveData(state, demo, [], () => []), demo);
  assert.equal(state.status, 'demo');
});

test('workspace switch invalidates prior data before an effect can run', () => {
  const previous = success({ workspace: 'a', secret: 'workspace-a-only' });
  const reconciled = reconcileLiveContext(previous, 'live', 'workspace-b', '/resource');
  assert.equal(reconciled.status, 'loading');
  assert.equal(reconciled.data, null);
  assert.equal(reconciled.requestKey, 'live:workspace-b:/resource');
});

test('auth and permission failures are distinguished from availability failures', () => {
  const auth = classifyLiveFailure({ status: 401 }, '/profiles?q=sensitive@example.com');
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.path, '/profiles');
  assert.equal(classifyLiveFailure({ status: 403 }, '/x').kind, 'permission');
  assert.equal(classifyLiveFailure({ status: 500 }, '/x').kind, 'unavailable');
});

test('a missing live workspace can render an explicit empty state', () => {
  const idle = stateForContext<unknown>('live', undefined, null);
  assert.equal(resolveLiveSurface([idle], true), 'empty');
});

test('repository policy scan finds no remaining silent live-to-mock fallback', () => {
  const componentsDir = join(process.cwd(), 'appui', 'components');
  const files = readdirSync(componentsDir).filter((file) => file.endsWith('.tsx'));
  const liveConsumers = files
    .map((file) => ({ file, source: readFileSync(join(componentsDir, file), 'utf8') }))
    .filter(({ source }) => source.includes('useLive<'));

  assert.ok(liveConsumers.length >= 13, 'the scan should cover every current useLive screen');
  for (const { file, source } of liveConsumers) {
    assert.match(source, /LiveDataBoundary/, `${file} must expose standardized live states`);
    assert.doesNotMatch(
      source,
      /\.data\s*\?[^:]+:\s*(?:MOCK_|INITIAL_|RAW_RECON|INBOUND|OUTBOUND_SEED|CREATIVES|PLANS)/s,
      `${file} still contains a direct live-to-mock fallback`,
    );
  }

  const explorer = readFileSync(join(componentsDir, 'ExplorerView.tsx'), 'utf8');
  assert.doesNotMatch(explorer, /liveResults\s*\?\?\s*runQuery/);
  const profiles = readFileSync(join(componentsDir, 'ProfilesView.tsx'), 'utf8');
  assert.doesNotMatch(profiles, /(?:channels|deviceList|weekly|timeline):\s*MOCK_PROFILE/);
  const login = readFileSync(join(componentsDir, 'LoginView.tsx'), 'utf8');
  const submitFlow = login.slice(login.indexOf('const handleSubmit'), login.indexOf('const handleOAuthLogin'));
  assert.doesNotMatch(submitFlow, /session\.demo\(\)/);
  const topBar = readFileSync(join(componentsDir, 'TopBar.tsx'), 'utf8');
  assert.match(topBar, /notifications = mode === 'demo'/);
  const funnels = readFileSync(join(componentsDir, 'FunnelsView.tsx'), 'utf8');
  assert.match(funnels, /O detalhamento por canal, campanha e criativo ainda não está disponível/);
  const app = readFileSync(join(process.cwd(), 'appui', 'App.tsx'), 'utf8');
  assert.match(app, /mode === 'live' \? 'dashboard' : 'onboarding'/);
});
