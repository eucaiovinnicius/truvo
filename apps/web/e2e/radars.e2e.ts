import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test as browser } from '@playwright/test';

const workspaceId = 'ws-radar-e2e';
type StoredRadar = { id: string; name: string; status: string; current_definition_version: number; current_model_reference: string | null; outcome_definition_id: string; prediction_window_days: number; audience_ast: Record<string, unknown>; readiness: Record<string, unknown> | null; updated_at: string };
const radars = new Map<string, StoredRadar>();
let server: ReturnType<typeof createServer>;

function readinessFor(body: Record<string, unknown>) {
  const shortHistory = (body.audienceAst as { op?: string; key?: string } | undefined)?.op === 'trait'
    && (body.audienceAst as { key?: string }).key === 'new';
  return shortHistory
    ? { status: 'insufficient_data', definitionVersion: 1, eligibleCustomerCount: 2, positiveOutcomeCount: 1, negativeCount: 1, historyDays: 5, minimumHistoryDays: 30, identityCoverage: 1, contextCoverage: { score: 100 }, blockers: ['insufficient_history'], warnings: [], activationReadiness: { status: 'not_configured', reasonCode: null } }
    : { status: 'ready_to_train', definitionVersion: 1, eligibleCustomerCount: 3, positiveOutcomeCount: 2, negativeCount: 1, historyDays: 90, minimumHistoryDays: 30, identityCoverage: 1, contextCoverage: { score: 100 }, blockers: [], warnings: ['quality_warnings'], activationReadiness: { status: 'not_configured', reasonCode: null } };
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://127.0.0.1:3100', 'access-control-allow-headers': 'content-type,authorization,x-workspace-id' });
  res.end(JSON.stringify(value));
}

browser.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, {});
    const path = new URL(req.url ?? '/', 'http://127.0.0.1:3101').pathname;
    if (path === '/v1/users/me') return json(res, { id: 'user-e2e', email: 'e2e@truvo.test', workspaces: [{ id: workspaceId, name: 'Workspace E2E' }] });
    if (req.headers['x-workspace-id'] !== workspaceId) return json(res, { message: 'workspace denied' }, 403);
    if (path === '/v1/radars/metadata/outcomes') return json(res, [{ id: 'purchase', name: 'Compra', kind: 'event' }, { id: 'renewal', name: 'Renovação validada', kind: 'custom' }]);
    if (path === '/v1/radars/metadata/destinations') return json(res, [{ id: 'destination-1', provider: 'test', display_name: 'Destino de teste', lifecycle_state: 'healthy', capabilities: ['activation'] }]);
    if (path === '/v1/radars' && req.method === 'GET') return json(res, [...radars.values()].map(({ audience_ast, readiness, ...row }) => row));
    if (path === '/v1/radars/metadata/readiness-preview' && req.method === 'POST') return json(res, readinessFor(await bodyOf(req)));
    if (path === '/v1/radars' && req.method === 'POST') {
      const body = await bodyOf(req); const id = `rad_e2e_${randomUUID()}`; const readiness = readinessFor(body);
      const radar: StoredRadar = { id, name: String(body.name), status: 'draft', current_definition_version: 1, current_model_reference: null, outcome_definition_id: String(body.outcomeDefinitionId), prediction_window_days: Number(body.predictionWindowDays), audience_ast: body.audienceAst as Record<string, unknown>, readiness: null, updated_at: new Date().toISOString() };
      radars.set(id, radar); return json(res, { radar, definition: { version: 1, outcome_definition_id: radar.outcome_definition_id, audience_ast: radar.audience_ast, prediction_window_days: radar.prediction_window_days, optimization_goal: {}, activation_destination: null, readiness }, activationReadiness: readiness.activationReadiness });
    }
    const match = path.match(/^\/v1\/radars\/([^/]+)(?:\/(validate|train|pause|archive))?$/); const radar = match ? radars.get(match[1]!) : null;
    if (!radar) return json(res, { message: 'not found' }, 404);
    if (match?.[2] === 'validate') { const readiness = readinessFor({ audienceAst: radar.audience_ast }); radar.readiness = readiness; radar.status = readiness.status; radar.updated_at = new Date().toISOString(); return json(res, readiness); }
    if (match?.[2] === 'train') { radar.status = 'training'; return json(res, { id: 'request-e2e' }); }
    if (match?.[2] === 'pause') { radar.status = 'paused'; return json(res, {}); }
    if (match?.[2] === 'archive') { radar.status = 'archived'; return json(res, {}); }
    return json(res, { radar, definition: { version: 1, outcome_definition_id: radar.outcome_definition_id, audience_ast: radar.audience_ast, prediction_window_days: radar.prediction_window_days, optimization_goal: {}, activation_destination: null, readiness: radar.readiness }, activationReadiness: { status: 'not_configured', reasonCode: null } });
  });
  await new Promise<void>((resolve) => server.listen(3101, '127.0.0.1', resolve));
});

browser.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

browser.beforeEach(async ({ page }) => {
  await page.addInitScript(({ workspace }) => { localStorage.setItem('truvo_mode', 'live'); localStorage.setItem('truvo_token', 'e2e-token'); localStorage.setItem('truvo_workspace', workspace); }, { workspace: workspaceId });
  await page.goto('/'); await page.locator('#nav-link-radars').click();
});

browser('purchase Radar browser flow persists the canonical question and lands on its detail', async ({ page }) => {
  await page.getByRole('button', { name: 'Criar Radar' }).first().click();
  await page.getByLabel('Resultado alvo').selectOption('purchase');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: '30 dias' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Validar dados' }).click();
  await expect(page.getByText('Dados prontos para treinamento')).toBeVisible();
  await page.getByRole('button', { name: 'Criar Radar' }).click();
  await expect(page.getByTestId('radar-detail')).toContainText('Radar de compra');
  await expect(page.getByTestId('radar-detail')).toContainText('Compra');
  expect(radars.size).toBe(1);
  const persisted = [...radars.values()][0]!;
  expect(persisted.outcome_definition_id).toBe('purchase');
  expect(persisted.prediction_window_days).toBe(30);
  expect(persisted.audience_ast).toEqual({ version: 1, op: 'identified' });
  expect(persisted.current_definition_version).toBe(1);
});

browser('not-ready browser flow explains insufficient history and preserves the Radar without training', async ({ page }) => {
  await page.getByRole('button', { name: 'Criar Radar' }).first().click();
  await page.getByLabel('Resultado alvo').selectOption('purchase');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Tipo de audiência').selectOption('trait');
  await page.getByLabel('Nome do atributo').fill('new');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Validar dados' }).click();
  await expect(page.getByText('Ainda não é possível treinar este Radar')).toBeVisible();
  await expect(page.getByText(/histórico suficiente/)).toBeVisible();
  await page.getByRole('button', { name: 'Criar Radar' }).click();
  await expect(page.getByTestId('radar-detail')).toContainText('Dados insuficientes');
  await expect(page.getByRole('button', { name: 'Treinar Radar' })).toHaveCount(0);
  expect(radars.size).toBe(2);
});
