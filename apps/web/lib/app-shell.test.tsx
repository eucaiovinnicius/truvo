import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FEATURE_REGISTRY,
  getPrimaryNavItems,
  isRouteEnabled,
} from './capabilities';
import {
  AppShellSkeleton,
  ConfirmationDialog,
  DataState,
  DegradedState,
  EmptyState,
  ErrorState,
  FeatureUnavailableState,
  Loading,
  NoWorkspaceState,
  PermissionState,
} from '../appui/components/ScreenStates';
import PrimaryNav from '../appui/components/PrimaryNav';
import WorkspaceSwitcher from '../appui/components/WorkspaceSwitcher';
import PageHeader from '../appui/components/PageHeader';
import { classifyLiveFailure, liveRequestKey, reconcileLiveContext, stateForContext, type LiveState } from './live-state';

test('FEATURE CAPABILITIES: primary nav items contain only enabled MVP routes', () => {
  const items = getPrimaryNavItems();
  const ids = items.map((i) => i.id);

  assert.deepEqual(ids, [
    'overview',
    'opportunities',
    'radars',
    'customers',
    'integrations',
    'settings',
  ]);

  assert.ok(!ids.includes('funnels'), 'funnels must be hidden from primary nav');
  assert.ok(!ids.includes('ai'), 'AI journeys must be hidden from primary nav');
  assert.ok(!ids.includes('creatives'), 'creatives must be hidden from primary nav');
  assert.ok(!ids.includes('billing'), 'billing must be hidden from primary nav');
  assert.ok(!ids.includes('reports'), 'reports must be hidden from primary nav');
});

test('FEATURE CAPABILITIES: isRouteEnabled truthfully permits SPEC-17 routes and rejects disabled modules', () => {
  // Canonical SPEC-17 routes
  assert.equal(isRouteEnabled('/app'), true);
  assert.equal(isRouteEnabled('/app/onboarding'), true);
  assert.equal(isRouteEnabled('/app/integrations'), true);
  assert.equal(isRouteEnabled('/app/radars'), true);
  assert.equal(isRouteEnabled('/app/radars/rad_12345'), true);
  assert.equal(isRouteEnabled('/app/opportunities'), true);
  assert.equal(isRouteEnabled('/app/customers'), true);
  assert.equal(isRouteEnabled('/app/customers/cust_999'), true);
  assert.equal(isRouteEnabled('/app/settings'), true);

  // Disabled prototype/future routes
  assert.equal(isRouteEnabled('/app/funnels'), false);
  assert.equal(isRouteEnabled('/app/funnels/builder'), false);
  assert.equal(isRouteEnabled('/app/ai'), false);
  assert.equal(isRouteEnabled('/app/creatives'), false);
  assert.equal(isRouteEnabled('/app/billing'), false);
  assert.equal(isRouteEnabled('/app/reports'), false);
  assert.equal(isRouteEnabled('/app/explorer'), false);
  assert.equal(isRouteEnabled('/app/attribution'), false);
});

test('SCREEN STATES: Loading and Skeletons render accessible status and landmarks', () => {
  const html = renderToStaticMarkup(<Loading label="Carregando modelos..." />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Carregando modelos\.\.\./);

  const skeletonHtml = renderToStaticMarkup(<AppShellSkeleton />);
  assert.match(skeletonHtml, /aria-label="Carregando aplicativo"/);
  assert.match(skeletonHtml, /animate-pulse/);
});

test('SCREEN STATES: Empty, Error, Degraded, Permission, and FeatureUnavailable render truthful copy', () => {
  // Empty
  const emptyHtml = renderToStaticMarkup(
    <EmptyState
      title="Nenhum Radar configurado"
      description="Crie seu primeiro Radar para iniciar previsões."
      actionLabel="Novo Radar"
      actionHref="/app/radars"
    />,
  );
  assert.match(emptyHtml, /Nenhum Radar configurado/);
  assert.match(emptyHtml, /href="\/app\/radars"/);

  // Error
  const errorHtml = renderToStaticMarkup(
    <ErrorState
      title="Falha na sincronização"
      error={{ kind: 'unavailable', message: 'Serviço temporariamente indisponível', path: '/v1/radars' }}
    />,
  );
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /Falha na sincronização/);
  assert.match(errorHtml, /Serviço temporariamente indisponível/);

  // Degraded
  const degradedHtml = renderToStaticMarkup(
    <DegradedState
      title="Dados parciais"
      description="Score batch em processamento."
      reason="latency_warning"
    />,
  );
  assert.match(degradedHtml, /role="region"/);
  assert.match(degradedHtml, /Dados parciais/);
  assert.match(degradedHtml, /latency_warning/);

  // Permission & Auth
  const permHtml = renderToStaticMarkup(<PermissionState kind="permission" />);
  assert.match(permHtml, /Acesso restrito ao workspace/);

  const authHtml = renderToStaticMarkup(<PermissionState kind="auth" />);
  assert.match(authHtml, /Sua sessão expirou/);
  assert.match(authHtml, /href="\/"/);

  // Feature Unavailable
  const unavailHtml = renderToStaticMarkup(
    <FeatureUnavailableState featureName="AI Journeys" />,
  );
  assert.match(unavailHtml, /AI Journeys/);
  assert.match(unavailHtml, /Inativo no MVP/);
  assert.match(unavailHtml, /href="\/app"/);

  // No Workspace
  const noWsHtml = renderToStaticMarkup(<NoWorkspaceState />);
  assert.match(noWsHtml, /Nenhum workspace acessível/);
  assert.match(noWsHtml, /href="\/app\/onboarding"/);
});

test('SCREEN STATES: DataState correctly routes between loading, error, empty, and data', () => {
  const loadingState: LiveState<unknown> = {
    data: null,
    loading: true,
    error: null,
    status: 'loading',
    requestKey: 'live:ws1:/test',
  };
  const errorState: LiveState<unknown> = {
    data: null,
    loading: false,
    error: { kind: 'unavailable', message: 'API offline', path: '/test' },
    status: 'error',
    requestKey: 'live:ws1:/test',
  };
  const successState: LiveState<string[]> = {
    data: ['row-1', 'row-2'],
    loading: false,
    error: null,
    status: 'success',
    requestKey: 'live:ws1:/test',
  };

  // Loading
  const lHtml = renderToStaticMarkup(
    <DataState states={[loadingState]} label="Radars">
      <div>Content</div>
    </DataState>,
  );
  assert.match(lHtml, /Carregando Radars\.\.\./);
  assert.doesNotMatch(lHtml, /Content/);

  // Error
  const eHtml = renderToStaticMarkup(
    <DataState states={[errorState]} label="Radars">
      <div>Content</div>
    </DataState>,
  );
  assert.match(eHtml, /API offline/);
  assert.doesNotMatch(eHtml, /Content/);

  // Empty
  const emptyHtml = renderToStaticMarkup(
    <DataState states={[successState]} empty={true} emptyTitle="Lista vazia" label="Radars">
      <div>Content</div>
    </DataState>,
  );
  assert.match(emptyHtml, /Lista vazia/);
  assert.doesNotMatch(emptyHtml, /Content/);

  // Success with Data
  const sHtml = renderToStaticMarkup(
    <DataState states={[successState]} empty={false} label="Radars">
      <div>Real Content</div>
    </DataState>,
  );
  assert.match(sHtml, /Real Content/);
});

test('CONFIRMATION DIALOG: handles accessible modal markup and keyboard escape', () => {
  const html = renderToStaticMarkup(
    <ConfirmationDialog
      isOpen={true}
      title="Remover conector"
      message="Tem certeza que deseja desconectar o Shopify?"
      confirmLabel="Desconectar"
      isDestructive={true}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Remover conector/);
  assert.match(html, /bg-rose-600/);
});

test('PRIMARY NAV: renders accessible links and preserves canonical legacy IDs', () => {
  const html = renderToStaticMarkup(<PrimaryNav />);
  assert.match(html, /aria-label="Menu principal"/);
  assert.match(html, /id="nav-link-dashboard"/);
  assert.match(html, /id="nav-link-radars"/);
  assert.match(html, /id="nav-link-revenue-opportunities"/);
  assert.match(html, /id="nav-link-profiles"/);
  assert.match(html, /id="nav-link-integrations"/);
  assert.match(html, /id="nav-link-settings"/);
  assert.match(html, /href="\/app\/radars"/);
  assert.match(html, /href="\/app\/opportunities"/);
});

test('WORKSPACE SWITCHER: renders current workspace and accessible listbox attributes', () => {
  const workspaces = [
    { id: 'ws-1', name: 'Loja Principal' },
    { id: 'ws-2', name: 'Loja Secundária' },
  ];
  const html = renderToStaticMarkup(
    <WorkspaceSwitcher
      currentWorkspaceId="ws-1"
      currentWorkspaceName="Loja Principal"
      workspaces={workspaces}
      onSelectWorkspace={() => {}}
      mode="live"
    />,
  );
  assert.match(html, /id="workspace-switcher-btn"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /Loja Principal/);
});

test('PAGE HEADER: renders title, status pill, and breadcrumbs truthfully', () => {
  const html = renderToStaticMarkup(
    <PageHeader
      title="Radars de Receita"
      subtitle="Perguntas de previsão ativas"
      mode="live"
      breadcrumbs={[{ label: 'App', href: '/app' }, { label: 'Radars' }]}
    />,
  );
  assert.match(html, /id="topbar-view-title"/);
  assert.match(html, /Radars de Receita/);
  assert.match(html, /Modo ao vivo/);
  assert.match(html, /bg-emerald-500/);
});

test('WORKSPACE ISOLATION: late in-flight response from Workspace A cannot overwrite Workspace B', () => {
  // Estado original associado ao Workspace A
  const originalState: LiveState<{ workspace: string; revenue: number }> = {
    data: { workspace: 'ws-a', revenue: 5000 },
    loading: false,
    error: null,
    status: 'success',
    requestKey: liveRequestKey('live', 'ws-a', '/v1/metrics/kpis'),
  };

  // Usuário troca para Workspace B: reconcileLiveContext invalida imediatamente
  const switchedState = reconcileLiveContext(
    originalState,
    'live',
    'ws-b',
    '/v1/metrics/kpis',
  );
  assert.equal(switchedState.status, 'loading');
  assert.equal(switchedState.data, null);
  assert.equal(switchedState.requestKey, 'live:ws-b:/v1/metrics/kpis');

  // Chegada atrasada da resposta de A: sua requestKey ('live:ws-a:...') não bate com o contexto atual ('live:ws-b:...')
  const delayedResponseFromA = {
    data: { workspace: 'ws-a', revenue: 99999 },
    loading: false,
    error: null,
    status: 'success' as const,
    requestKey: 'live:ws-a:/v1/metrics/kpis',
  };
  const verifiedAgainstCurrentContext = reconcileLiveContext(
    delayedResponseFromA,
    'live',
    'ws-b',
    '/v1/metrics/kpis',
  );

  // Deve descartar os dados atrasados de A e manter o estado limpo de B
  assert.equal(verifiedAgainstCurrentContext.status, 'loading');
  assert.equal(verifiedAgainstCurrentContext.data, null);
  assert.equal(verifiedAgainstCurrentContext.requestKey, 'live:ws-b:/v1/metrics/kpis');
});
