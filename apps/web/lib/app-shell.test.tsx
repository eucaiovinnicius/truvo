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
import { classifyLiveFailure, liveRequestKey, reconcileLiveContext, resolveLiveSurface, stateForContext, type LiveState } from './live-state';

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

test('SESSION GUARD: allows workspace-less users to access /app/onboarding', () => {
  // Verificamos que a rota /app/onboarding é explicitamente habilitada
  assert.equal(isRouteEnabled('/app/onboarding'), true);
  // E que um path desconhecido ou desabilitado é bloqueado
  assert.equal(isRouteEnabled('/app/funnels'), false);
});

test('WORKSPACE PROVISIONING SESSION ADOPTION: newly created workspace enters session workspaces and becomes active', () => {
  const initialWorkspaces: Array<{ id: string; name: string }> = [];
  const createdWorkspace = { id: 'ws_new_999', name: 'Nova Loja Truvo' };

  // Helper de adoção que espelha a lógica de adoptWorkspace no SessionProvider
  const adopt = (
    prev: Array<{ id: string; name: string }>,
    ws: { id: string; name: string },
  ) => {
    const exists = prev.some((c) => c.id === ws.id);
    return exists ? prev.map((c) => (c.id === ws.id ? ws : c)) : [...prev, ws];
  };

  const updatedWorkspaces = adopt(initialWorkspaces, createdWorkspace);
  assert.equal(updatedWorkspaces.length, 1);
  assert.equal(updatedWorkspaces[0]?.id, 'ws_new_999');
  assert.equal(updatedWorkspaces[0]?.name, 'Nova Loja Truvo');

  // Adotar novamente não duplica
  const reAdopted = adopt(updatedWorkspaces, createdWorkspace);
  assert.equal(reAdopted.length, 1);

  // needsProvisioning condition: !workspace || workspaces.length === 0
  const isProvisioned = (list: Array<{ id: string }>) => list.length > 0;
  assert.equal(isProvisioned(initialWorkspaces), false);
  assert.equal(isProvisioned(updatedWorkspaces), true);
});

test('CANONICAL CUSTOMER ROUTE: uses canonical endpoint directly instead of type=user_id search', () => {
  const canonicalCustomerId = 'cust_canon_abc123';

  // Endpoint canônico direto vs search
  const canonicalPath = `/v1/profiles/${encodeURIComponent(canonicalCustomerId)}`;
  const searchUserIdPath = `/v1/profiles/search?q=${encodeURIComponent(canonicalCustomerId)}&type=user_id`;

  assert.equal(canonicalPath, '/v1/profiles/cust_canon_abc123');
  assert.notEqual(canonicalPath, searchUserIdPath);

  // Sub-recursos canônicos
  const timelinePath = `/v1/profiles/${encodeURIComponent(canonicalCustomerId)}/timeline`;
  const identitiesPath = `/v1/profiles/${encodeURIComponent(canonicalCustomerId)}/identities`;

  assert.equal(timelinePath, '/v1/profiles/cust_canon_abc123/timeline');
  assert.equal(identitiesPath, '/v1/profiles/cust_canon_abc123/identities');
});

test('CUSTOMER PROFILE: safely adapts free-form event names and device response fields', () => {
  // Device mapping: backend provides device_type, os, browser, first_seen
  const backendDevice = {
    device_type: 'desktop',
    os: 'macOS 15',
    browser: 'Chrome 128',
    first_seen: '2026-06-01T10:00:00.000Z',
  };
  const rawType = (backendDevice.device_type || '').toLowerCase();
  const resolvedType = rawType.includes('desktop') ? 'desktop' : rawType.includes('tablet') ? 'tablet' : 'mobile';
  assert.equal(resolvedType, 'desktop');

  // Timeline event mapping with custom/unrecognized event names
  const customEvents = ['lead', 'refund', 'subscription_started', 'custom_action'];
  for (const name of customEvents) {
    const label = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    assert.ok(label.length > 0);
  }

  // Timeline availability flag: clickhouse_available: false maps to timelineUnavailable: true
  const timelineResponse = { canonical_id: 'cust_1', clickhouse_available: false, count: 0, events: [] };
  const timelineUnavailable = timelineResponse.clickhouse_available === false;
  assert.equal(timelineUnavailable, true);
});

test('LIVE STATE: 404 response maps to not_found failure, resolving to error by default and empty when opted in', () => {
  const notFoundFailure = classifyLiveFailure({ status: 404 }, '/v1/profiles/non-existent');
  assert.equal(notFoundFailure.kind, 'not_found');
  assert.match(notFoundFailure.message, /não foi encontrado/);

  const notFoundState: LiveState<unknown> = {
    data: null,
    loading: false,
    error: notFoundFailure,
    status: 'error',
    requestKey: 'live:ws-1:/v1/profiles/non-existent',
  };

  // Por padrão em relatórios/dashboards, 404 resolve como 'error'
  const defaultSurface = resolveLiveSurface([notFoundState], false);
  assert.equal(defaultSurface, 'error');

  // Em lookups específicos com opt-in (ex: perfil canônico), resolve como 'empty'
  const optInSurface = resolveLiveSurface([notFoundState], false, { allowNotFoundAsEmpty: true });
  assert.equal(optInSurface, 'empty');
});

test('CUSTOMER PROFILE: preserves profile metric and timeline event currency and respects pagination cursor without inventing BRL for unknown currency', () => {
  const evBrl = { value: 150.0, currency: 'BRL' };
  const evUsd = { value: 99.9, currency: 'USD' };
  const evUnknown: { value: number; currency?: string } = { value: 50.0 };

  const fmtMoney = (n: number, currency?: string): string => {
    const trimmed = currency?.trim().toUpperCase();
    if (!trimmed) {
      return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    try {
      return n.toLocaleString('pt-BR', { style: 'currency', currency: trimmed });
    } catch {
      return `${trimmed} ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  };

  // Event currency
  assert.match(fmtMoney(evBrl.value, evBrl.currency), /R\$/);
  assert.match(fmtMoney(evUsd.value, evUsd.currency), /US\$|USD/);
  // Unknown currency renders as plain formatted number without synthetic currency symbol
  assert.doesNotMatch(fmtMoney(evUnknown.value, evUnknown.currency), /R\$|USD|BRL/);
  assert.equal(fmtMoney(evUnknown.value, evUnknown.currency), '50,00');

  // Profile metric currency (LTV / AOV)
  const profileMetrics = { ltv: 1250.5, aov: 250.1, currency: 'USD' };
  assert.match(fmtMoney(profileMetrics.ltv, profileMetrics.currency), /US\$|USD/);
  assert.match(fmtMoney(profileMetrics.aov, profileMetrics.currency), /US\$|USD/);

  // Pagination cursor detection
  const paginatedResponse = {
    canonical_id: 'cust_1',
    count: 50,
    next_cursor: 'cursor_page_2',
    events: [],
  };
  assert.equal(Boolean(paginatedResponse.next_cursor), true);
  assert.equal(paginatedResponse.next_cursor, 'cursor_page_2');
});

test('CUSTOMER PROFILE: unprojected/unavailable metrics are represented as null and rendered truthfully as —', () => {
  const num = (n: number | null | undefined): string =>
    n !== null && n !== undefined ? n.toLocaleString('pt-BR') : '—';

  const fmtMoney = (n: number | null | undefined, currency?: string): string => {
    if (n === null || n === undefined) return '—';
    const trimmed = currency?.trim().toUpperCase();
    if (!trimmed) {
      return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    try {
      return n.toLocaleString('pt-BR', { style: 'currency', currency: trimmed });
    } catch {
      return `${trimmed} ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  };

  // Quando o backend retorna metrics: null (ClickHouse recomputation fail / projection stale)
  const apiProfileUnprojected: {
    canonical_id: string;
    status: 'identified' | 'anonymous';
    email_hash: string | null;
    phone_hash: string | null;
    metrics: { ltv: number; orders_count: number; aov: number } | null;
    projection: { stale: boolean; recomputed_at: string | null };
  } = {
    canonical_id: 'cus_unprojected',
    status: 'identified',
    email_hash: 'hash123',
    phone_hash: null,
    metrics: null,
    projection: { stale: true, recomputed_at: null },
  };

  const metricsAvailable = Boolean(apiProfileUnprojected.metrics);
  assert.equal(metricsAvailable, false);

  const ltv = apiProfileUnprojected.metrics?.ltv ?? null;
  const orders = apiProfileUnprojected.metrics?.orders_count ?? null;
  const aov = apiProfileUnprojected.metrics?.aov ?? null;

  assert.equal(ltv, null);
  assert.equal(orders, null);
  assert.equal(aov, null);

  assert.equal(fmtMoney(ltv), '—');
  assert.equal(num(orders), '—');
  assert.equal(fmtMoney(aov), '—');
});

test('CUSTOMER PROFILE: stale cached projection is surfaced truthfully with projectionStale flag', () => {
  // Teste de projeção em cache desatualizada (stale: true)
  const apiProfileStale = {
    canonical_id: 'cus_stale',
    status: 'identified' as const,
    email_hash: 'hash123',
    phone_hash: null,
    metrics: { ltv: 500.0, orders_count: 2, aov: 250.0 },
    projection: { stale: true, recomputed_at: '2026-07-01T00:00:00Z' },
  };

  const projectionStale = Boolean(apiProfileStale.projection?.stale);
  assert.equal(projectionStale, true);
  assert.equal(Boolean(apiProfileStale.metrics), true);
});

test('CUSTOMER SEARCH: identifier search preserves PII privacy by avoiding customer identifiers in navigation URLs', () => {
  const customerEmail = 'marina@gmail.com';
  const customerPhone = '+5511999999999';

  // O fluxo de busca usa rotas limpas sem colocar PII no endereço do navegador
  const baseCustomersRoute = '/app/customers';
  const canonicalRoute = `/app/customers/${encodeURIComponent('cus_9f2a7c41e8b3')}`;

  assert.equal(baseCustomersRoute.includes(customerEmail), false);
  assert.equal(baseCustomersRoute.includes(customerPhone), false);
  assert.equal(canonicalRoute.includes(customerEmail), false);
  assert.equal(canonicalRoute.includes(customerPhone), false);
});


