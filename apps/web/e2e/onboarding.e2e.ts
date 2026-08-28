import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';

const workspace = 'workspace-onboarding-e2e';
const workspaceB = 'workspace-onboarding-b';
type MetadataMode = 'ok' | 'empty' | 'fail';
let server: ReturnType<typeof createServer>;
let step = 'workspace_basics';
let selectedPath: 'ecommerce' | 'saas' | 'custom' | null = null;
let connectionsMode: MetadataMode = 'ok';
let outcomesMode: MetadataMode = 'ok';
let radarCreates = 0;
let onboardingCalls = 0;
let delayA = false;
let failB = false;
let releaseA: (() => void) | null = null;
let callsA = 0;
let callsB = 0;

const progress = () => ({
  progress: { current_step: step, status: step === 'completed' ? 'completed' : 'in_progress', selected_path: selectedPath },
  source: { state: selectedPath ?? 'custom', healthy: true, provider: selectedPath === 'saas' ? 'stripe' : 'truvo_events' },
  ttfvMs: step === 'completed' ? 1200 : null,
  recommendations: { ecommerce: ['shopify'], saas: ['stripe'], custom: ['truvo_events'] },
  readiness: step === 'create_radar' ? { radarReadiness: { status: 'not_ready', reasonCodes: ['insufficient_history'] } } : undefined,
});

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': 'http://127.0.0.1:3100',
    'access-control-allow-headers': 'content-type,authorization,x-workspace-id',
  });
  res.end(JSON.stringify(value));
}

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, {});
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/v1/users/me') return json(res, { id: 'user', email: 'onboarding@truvo.test', workspaces: [{ id: workspace, name: 'Workspace A' }, { id: workspaceB, name: 'Workspace B' }] });
    const ws = String(req.headers['x-workspace-id'] ?? '');
    if (![workspace, workspaceB].includes(ws)) return json(res, { message: 'denied' }, 403);
    if (path.endsWith('/connectors/onboarding-sources')) {
      if (connectionsMode === 'fail') return json(res, { message: 'sources unavailable' }, 503);
      if (connectionsMode === 'empty') return json(res, []);
      return json(res, ws === workspaceB
        ? [{ id: 'conn-b', provider: 'stripe', displayName: 'Only B', lifecycleState: 'healthy', credentialStatus: 'valid', capabilities: ['read'] }]
        : [{ id: 'conn-a', provider: 'shopify', displayName: 'Shopify A safe', lifecycleState: 'healthy', credentialStatus: 'valid', capabilities: ['read'] }]);
    }
    if (path === '/v1/radars/metadata/outcomes') {
      if (outcomesMode === 'fail') return json(res, { message: 'outcomes unavailable' }, 503);
      if (outcomesMode === 'empty') return json(res, []);
      return json(res, ws === workspaceB ? [{ id: 'renewal-b', name: 'Renewal B' }] : [{ id: 'purchase', name: 'Compra real' }]);
    }
    if (path === '/v1/onboarding' && req.method === 'GET') {
      onboardingCalls++;
      if (delayA && ws === workspace) {
        callsA++;
        await new Promise<void>((resolve) => { releaseA = resolve; });
        return json(res, { ...progress(), progress: { ...progress().progress, current_step: 'connect_context', selected_path: 'custom' } });
      }
      if (ws === workspaceB) {
        callsB++;
        if (failB) return json(res, { message: 'B unavailable' }, 503);
        return json(res, { ...progress(), progress: { ...progress().progress, current_step: 'verify_data', status: 'syncing', selected_path: 'saas' }, source: { state: 'syncing', healthy: false, provider: 'stripe' } });
      }
      return json(res, progress());
    }
    if (path === '/v1/onboarding/start') { step = 'choose_path'; return json(res, progress()); }
    if (path === '/v1/onboarding/path') { selectedPath = (await body(req)).path; step = 'connect_context'; return json(res, progress()); }
    if (path === '/v1/onboarding/connection') { step = 'verify_data'; return json(res, progress()); }
    if (path === '/v1/onboarding/verify') { step = 'readiness'; return json(res, { ...progress(), detected: true, counts: { customers: 1 } }); }
    if (path === '/v1/onboarding/readiness') { step = 'create_radar'; return json(res, progress()); }
    if (path === '/v1/onboarding/radar') { radarCreates++; step = 'completed'; return json(res, { ...progress(), radar: { radar: { id: 'rad_first' } }, replay: radarCreates > 1 }); }
    return json(res, { message: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(3101, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }, testInfo) => {
  step = 'workspace_basics'; selectedPath = null; connectionsMode = 'ok'; outcomesMode = 'ok'; radarCreates = 0; onboardingCalls = 0; delayA = false; failB = false; releaseA = null; callsA = 0; callsB = 0;
  if (!testInfo.title.includes('demo')) await page.addInitScript(({ ws }) => { localStorage.setItem('truvo_mode', 'live'); localStorage.setItem('truvo_token', 'production-shaped-jwt'); localStorage.setItem('truvo_workspace', ws); }, { ws: workspace });
  await page.goto('/');
  if (!testInfo.title.includes('demo')) { await page.getByRole('button', { name: 'Launch Setup Wizard' }).click(); await expect(page.getByTestId('onboarding-flow')).toBeVisible(); }
});

async function reopen(page: import('@playwright/test').Page) {
  const exit = page.getByTestId('onboarding-flow').getByRole('button', { name: 'Sair', exact: true });
  if (await exit.count()) { await exit.click(); await expect(page.getByTestId('onboarding-flow')).toHaveCount(0); }
  await page.getByRole('button', { name: 'Launch Setup Wizard' }).click();
  await expect(page.getByTestId('onboarding-flow').or(page.getByTestId('onboarding-load-error')).or(page.getByRole('status'))).toBeVisible();
}

test('guided custom path resumes, reports insufficient history and reaches the real Radar destination', async ({ page }) => {
  await page.getByLabel('Nome do workspace').fill('Acme Revenue'); await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('button', { name: /Eventos personalizados/ }).click(); await expect(page.getByText('Envie um evento real')).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Launch Setup Wizard' }).click(); await expect(page.getByText('Envie um evento real')).toBeVisible();
  await page.getByRole('button', { name: 'Verificar dados recebidos' }).click(); await page.getByRole('button', { name: 'Ver prontidão' }).click();
  await page.getByRole('button', { name: 'Criar Radar real' }).click(); await expect(page.getByText('Seu primeiro Radar foi criado')).toBeVisible();
  await page.getByRole('button', { name: 'Ver Radars' }).click(); await expect(page.getByRole('heading', { name: 'Quem vai comprar a seguir?' })).toBeVisible(); expect(radarCreates).toBe(1);
});

test('explicit demo renders synthetic mode without any live onboarding request', async ({ page }) => {
  await page.getByRole('button', { name: 'Entrar na demonstração' }).click(); await expect(page.getByText('Modo demonstração — dados sintéticos')).toBeVisible();
  await expect(page.getByText('Multi-Channel Attribution Feed')).toBeVisible(); expect(onboardingCalls).toBe(0);
  await page.getByRole('button', { name: 'Launch Setup Wizard' }).click(); expect(onboardingCalls).toBe(0);
});

test('workspace B rejects delayed A state, data and polling after switch', async ({ page }) => {
  delayA = true; await reopen(page);
  await expect.poll(() => callsA).toBeGreaterThanOrEqual(1); await page.locator('#workspace-switcher-btn').click(); await page.getByRole('button', { name: 'Workspace B' }).click();
  await expect(page.getByText('Estamos verificando seu Contexto')).toBeVisible(); releaseA?.();
  await expect(page.getByText('Envie um evento real')).toHaveCount(0); const callsAAfterSwitch = callsA;
  await expect.poll(() => callsB).toBeGreaterThanOrEqual(2); expect(callsA).toBe(callsAAfterSwitch);
  const callsBeforeFailure = callsB; failB = true; await expect.poll(() => callsB, { timeout: 8_000 }).toBeGreaterThan(callsBeforeFailure);
  const pollingAlert = page.getByTestId('onboarding-flow').getByRole('alert');
  await expect(pollingAlert).toContainText('B unavailable'); await expect(page.getByText('Estamos verificando seu Contexto')).toBeVisible();
  failB = false; await pollingAlert.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(pollingAlert).toHaveCount(0); await expect(page.getByText('Estamos verificando seu Contexto')).toBeVisible();
  delayA = false; await page.locator('#workspace-switcher-btn').click(); await page.getByRole('button', { name: 'Workspace A' }).click(); await expect(page.getByLabel('Nome do workspace')).toBeVisible();
});

test('connections distinguish legitimate empty, failure and retry recovery', async ({ page }) => {
  step = 'connect_context'; selectedPath = 'ecommerce'; connectionsMode = 'empty'; await reopen(page);
  await expect(page.getByText(/Nenhuma fonte compatível foi configurada/)).toBeVisible();
  connectionsMode = 'fail'; await reopen(page); await expect(page.getByTestId('onboarding-load-error')).toContainText('sources unavailable'); await expect(page.getByText(/Nenhuma fonte compatível/)).toHaveCount(0);
  connectionsMode = 'ok'; await page.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(page.getByText('Shopify A safe')).toBeVisible();
});

test('outcomes distinguish legitimate empty, failure and retry recovery', async ({ page }) => {
  step = 'create_radar'; selectedPath = 'custom'; outcomesMode = 'empty'; await reopen(page);
  await expect(page.getByText('Nenhum resultado alvo disponível')).toBeVisible(); await expect(page.getByRole('button', { name: 'Criar Radar real' })).toBeDisabled();
  outcomesMode = 'fail'; await reopen(page); await expect(page.getByTestId('onboarding-load-error')).toContainText('outcomes unavailable');
  outcomesMode = 'ok'; await page.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(page.getByRole('option', { name: 'Compra real' })).toBeAttached(); await expect(page.getByRole('button', { name: 'Criar Radar real' })).toBeEnabled();
});
