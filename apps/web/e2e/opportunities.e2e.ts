import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, test as browser } from '@playwright/test';
import { closeDb, createDb, type Database } from '@truvo/db';
import { sql } from 'drizzle-orm';

const WS = '00000000-0000-0000-0000-000000001100';
const USER = '00000000-0000-0000-0000-000000001101';
const CUTOFF = '2026-08-27T00:00:00.000Z';
const RADARS = {
  main: { id: 'rad-e2e-main', name: 'Próxima compra', target: 'purchase', model: 'model-e2e-main', count: 55 },
  noMoney: { id: 'rad-e2e-no-money', name: 'Renovação sem histórico monetário', target: 'renewal', model: 'model-e2e-no-money', count: 2 },
  mixed: { id: 'rad-e2e-mixed', name: 'Compra multimoeda', target: 'mixed-purchase', model: 'model-e2e-mixed', count: 2 },
} as const;

let db: Database;
let opportunities: any;
let server: ReturnType<typeof createServer>;
let providerWrites = 0;

const destinationAdapter = {
  definition: { provider: 'opportunity-e2e', displayName: 'E2E destination', role: 'destination', capabilities: ['outbound_audience'], credentialKind: 'api_key' },
  testConnection: async () => ({ ok: true, credentialStatus: 'valid', checks: {}, message: 'ok' }),
  write: async () => { providerWrites += 1; return { status: 'sent' as const, externalResultId: 'e2e-audience-1' }; },
};

async function bodyOf(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function cors(contentType: string) {
  return { 'content-type': contentType, 'access-control-allow-origin': 'http://127.0.0.1:3100', 'access-control-allow-headers': 'content-type,authorization,x-workspace-id' };
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, cors('application/json')); res.end(JSON.stringify(value));
}

async function clean() {
  await db.execute(sql`delete from opportunity_activations where workspace_id=${WS}`);
  await db.execute(sql`delete from opportunity_exports where workspace_id=${WS}`);
  await db.execute(sql`delete from connector_destination_writes where workspace_id=${WS}`);
  await db.execute(sql`delete from opportunity_rows where workspace_id=${WS}`);
  await db.execute(sql`delete from opportunity_batches where workspace_id=${WS}`);
  await db.execute(sql`delete from radar_propensity_scores where workspace_id=${WS}`);
  await db.execute(sql`delete from radar_score_batches where workspace_id=${WS}`);
  await db.execute(sql`delete from radar_model_versions where workspace_id=${WS}`);
  await db.execute(sql`delete from radar_training_requests where workspace_id=${WS}`);
  await db.execute(sql`delete from radar_definition_versions where workspace_id=${WS}`);
  await db.execute(sql`delete from radars where workspace_id=${WS}`);
  await db.execute(sql`delete from customer_outcomes where workspace_id=${WS}`);
  await db.execute(sql`delete from customer_identifiers where workspace_id=${WS}`);
  await db.execute(sql`delete from customers where workspace_id=${WS}`);
  await db.execute(sql`delete from outcome_definitions where workspace_id=${WS}`);
  await db.execute(sql`delete from connector_connections where workspace_id=${WS}`);
  await db.execute(sql`delete from audit_log where workspace_id=${WS}`);
  await db.execute(sql`delete from workspace_members where workspace_id=${WS}`);
  await db.execute(sql`delete from workspaces where id=${WS}`);
  await db.execute(sql`delete from users where id=${USER}`);
}

async function seedRadar(config: typeof RADARS[keyof typeof RADARS], customerPrefix: string) {
  await db.execute(sql`insert into radars(workspace_id,id,name,status,current_definition_version) values(${WS},${config.id},${config.name},'active',1)`);
  await db.execute(sql`insert into radar_definition_versions(workspace_id,radar_id,version,outcome_definition_id,audience_ast,prediction_window_days,optimization_goal,activation_destination,readiness) values
    (${WS},${config.id},1,${config.target},'{"version":1,"op":"identified"}'::jsonb,30,'{}'::jsonb,'{"connectionId":"dest-e2e","capability":"activation"}'::jsonb,'{}'::jsonb)`);
  await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values
    (${WS},${`req-${config.id}`},${config.id},1,'initial','succeeded',${`corr-${config.id}`})`);
  await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values
    (${WS},${config.model},${config.id},1,${`req-${config.id}`},${config.target},30,'active','logistic_regression','propensity-v1','models',${`${config.model}.joblib`},${`supabase://models/${config.model}.joblib`},'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'selected',now())`);
  await db.execute(sql`update radars set current_model_reference=${config.model} where workspace_id=${WS} and id=${config.id}`);
  await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values
    (${WS},${config.id},1,${config.model},${CUTOFF},'completed',${config.count},now())`);
  await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at)
    select ${WS},${config.id},1,${config.model},${customerPrefix}||lpad(g::text,3,'0'),${CUTOFF},
      case when g=1 then '0.8'::numeric else '0.78'::numeric end,'propensity-v1','["returning_customer","unknown_future_code"]'::jsonb,${CUTOFF}
    from generate_series(1,${config.count}) g`);
}

async function seed() {
  await clean(); providerWrites = 0;
  await db.execute(sql`insert into users(id,email,full_name) values(${USER},'opportunity-e2e@truvo.test','Opportunity E2E')`);
  await db.execute(sql`insert into workspaces(id,name,slug,created_by) values(${WS},'Opportunity E2E','opportunity-e2e',${USER})`);
  await db.execute(sql`insert into workspace_members(workspace_id,user_id,role,status) values(${WS},${USER},'owner','active')`);
  await db.execute(sql`insert into outcome_definitions(workspace_id,id,outcome_namespace,outcome_key,name,kind,definition,source_namespace) values
    (${WS},'purchase','canonical','purchase','Compra','event','{}'::jsonb,'test'),
    (${WS},'renewal','canonical','renewal','Renovação','event','{}'::jsonb,'test'),
    (${WS},'mixed-purchase','canonical','mixed_purchase','Compra multimoeda','event','{}'::jsonb,'test')`);
  for (const [prefix, count] of [['main-', 55], ['nomoney-', 2], ['mixed-', 2]] as const) {
    await db.execute(sql`insert into customers(workspace_id,id,status,source_namespace,first_seen_at,last_seen_at)
      select ${WS},${prefix}||lpad(g::text,3,'0'),'identified','e2e','2026-01-01','2026-08-26' from generate_series(1,${count}) g`);
    await db.execute(sql`insert into customer_identifiers(workspace_id,id,customer_id,identifier_type,provider_namespace,identifier_value,source_namespace,first_seen_at,last_seen_at)
      select ${WS},'id-'||${prefix}||lpad(g::text,3,'0'),${prefix}||lpad(g::text,3,'0'),'external_id','e2e','destination-'||${prefix}||g,'e2e','2026-01-01','2026-08-26' from generate_series(1,${count}) g`);
  }
  await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at)
    select ${WS},'out-main-'||customer_no||'-'||sample_no,'main-'||lpad(customer_no::text,3,'0'),'purchase','canonical','purchase','d-main-'||customer_no||'-'||sample_no,'e-main-'||customer_no||'-'||sample_no,125,'BRL','e2e','2026-08-01'
    from generate_series(1,55) customer_no cross join generate_series(1,3) sample_no`);
  await db.execute(sql`insert into customer_outcomes(workspace_id,id,customer_id,outcome_definition_id,outcome_namespace,outcome_key,dedupe_key,event_id,value,currency,source_namespace,observed_at)
    select ${WS},'out-mixed-'||customer_no||'-'||sample_no,'mixed-'||lpad(customer_no::text,3,'0'),'mixed-purchase','canonical','mixed_purchase','d-mixed-'||customer_no||'-'||sample_no,'e-mixed-'||customer_no||'-'||sample_no,100,case when customer_no=1 then 'BRL' else 'USD' end,'e2e','2026-08-01'
    from generate_series(1,2) customer_no cross join generate_series(1,3) sample_no`);
  await db.execute(sql`insert into connector_connections(workspace_id,id,provider,role,display_name,lifecycle_state,credential_status,capabilities) values
    (${WS},'dest-e2e','opportunity-e2e','destination','Destino E2E','healthy','valid','["outbound_audience"]'::jsonb)`);
  await seedRadar(RADARS.main, 'main-'); await seedRadar(RADARS.noMoney, 'nomoney-'); await seedRadar(RADARS.mixed, 'mixed-');
  await opportunities.materialize(WS, RADARS.main.id); await opportunities.materialize(WS, RADARS.noMoney.id); await opportunities.materialize(WS, RADARS.mixed.id);
}

async function radarList() {
  return db.execute(sql`select r.id,r.name,r.status,r.current_definition_version,r.current_model_reference,d.outcome_definition_id,d.prediction_window_days,r.updated_at from radars r join radar_definition_versions d on d.workspace_id=r.workspace_id and d.radar_id=r.id and d.version=r.current_definition_version where r.workspace_id=${WS} order by r.name`);
}

async function radarDetail(id: string) {
  const [radar] = await db.execute(sql`select r.id,r.name,r.status,r.current_definition_version,r.current_model_reference,d.outcome_definition_id,d.prediction_window_days,d.activation_destination,d.audience_ast,d.optimization_goal,d.readiness,r.updated_at from radars r join radar_definition_versions d on d.workspace_id=r.workspace_id and d.radar_id=r.id and d.version=r.current_definition_version where r.workspace_id=${WS} and r.id=${id}`) as any[];
  const [connection] = await db.execute(sql`select lifecycle_state from connector_connections where workspace_id=${WS} and id='dest-e2e'`) as any[];
  return { radar, definition: { version: radar.current_definition_version, outcome_definition_id: radar.outcome_definition_id, prediction_window_days: radar.prediction_window_days, activation_destination: radar.activation_destination, audience_ast: radar.audience_ast, optimization_goal: radar.optimization_goal, readiness: radar.readiness }, activationReadiness: { status: connection?.lifecycle_state === 'healthy' ? 'ready' : 'unavailable', reasonCode: connection?.lifecycle_state === 'healthy' ? null : 'activation_destination_unavailable' } };
}

browser.beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for Opportunity browser E2E');
  // Playwright's transform does not support parameter decorators. Load the real,
  // already-built Nest services so this harness executes production code.
  const { AuditService } = require('../../api/dist/modules/audit/audit.service.js');
  const { ConnectorConnectionService } = require('../../api/dist/modules/connectors/connector-connection.service.js');
  const { ConnectorDestinationService } = require('../../api/dist/modules/connectors/connector-destination.service.js');
  const { ConnectorRegistryService } = require('../../api/dist/modules/connectors/connector-registry.service.js');
  const { OpportunitiesService } = require('../../api/dist/modules/opportunities/opportunities.service.js');
  db = createDb(); const registry = new ConnectorRegistryService(); registry.registerDestination(destinationAdapter);
  const audit = new AuditService(db); const connections = new ConnectorConnectionService(db, audit, registry);
  opportunities = new OpportunitiesService(db, audit, connections, registry, new ConnectorDestinationService(db, connections, registry, audit));
  server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return json(res, {});
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:3101'); const path = url.pathname;
      if (path === '/v1/users/me') return json(res, { id: USER, email: 'opportunity-e2e@truvo.test', workspaces: [{ id: WS, name: 'Opportunity E2E' }] });
      if (req.headers['x-workspace-id'] !== WS) return json(res, { code: 'workspace_forbidden', message: 'workspace_forbidden' }, 403);
      if (path === '/v1/radars' && req.method === 'GET') return json(res, await radarList());
      const radarMatch = path.match(/^\/v1\/radars\/([^/]+)$/); if (radarMatch) return json(res, await radarDetail(radarMatch[1]!));
      if (path === '/v1/opportunities/summary') return json(res, await opportunities.summary(WS, url.searchParams.get('radarId')!));
      if (path === '/v1/opportunities' && req.method === 'GET') return json(res, await opportunities.list(WS, url.searchParams.get('radarId')!, {
        cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 50),
        sort: (url.searchParams.get('sort') ?? undefined) as any, direction: (url.searchParams.get('direction') ?? undefined) as any,
        filters: { scoreBands: url.searchParams.get('scoreBands')?.split(',') as any, monetary: url.searchParams.has('monetary') ? url.searchParams.get('monetary') === 'true' : undefined, currency: url.searchParams.get('currency') ?? undefined },
      }));
      const opportunityMatch = path.match(/^\/v1\/opportunities\/(oppr_[^/]+)$/); if (opportunityMatch) return json(res, await opportunities.detail(WS, opportunityMatch[1]!));
      if (path === '/v1/opportunities/export' && req.method === 'POST') { const result = await opportunities.exportCsv(WS, USER, await bodyOf(req)); res.writeHead(200, cors('text/csv; charset=utf-8')); return res.end(result.csv); }
      if (path === '/v1/opportunities/activation/preview' && req.method === 'POST') return json(res, await opportunities.previewActivation(WS, await bodyOf(req)));
      if (path === '/v1/opportunities/activation' && req.method === 'POST') return json(res, await opportunities.activate(WS, USER, await bodyOf(req)));
      return json(res, { message: 'not found' }, 404);
    } catch (error) {
      const response = typeof (error as any).getResponse === 'function' ? (error as any).getResponse() : { code: 'internal_error', message: (error as Error).message };
      json(res, response, typeof (error as any).getStatus === 'function' ? (error as any).getStatus() : 500);
    }
  });
  await new Promise<void>((resolve) => server.listen(3101, '127.0.0.1', resolve));
});

browser.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await clean(); await closeDb(db);
});

browser.beforeEach(async ({ page }) => {
  await seed();
  await page.addInitScript(({ workspace }) => { localStorage.setItem('truvo_mode', 'live'); localStorage.setItem('truvo_token', 'e2e-token'); localStorage.setItem('truvo_workspace', workspace); }, { workspace: WS });
  await page.goto('/'); await page.locator('#nav-link-revenue-opportunities').click();
  await expect(page.getByTestId('revenue-opportunities')).toBeVisible();
});

browser('primary Opportunity path ranks, details, filters, paginates, exports and activates real materialized rows', async ({ page }) => {
  await page.getByLabel('Radar de oportunidades').selectOption(RADARS.main.id);
  await expect(page.getByText('55', { exact: true }).first()).toBeVisible();
  const table = page.locator('table'); await expect(table.locator('tbody tr')).toHaveCount(50);
  await expect(table.locator('tbody tr').first()).toContainText('80.0%');
  await expect(table.locator('tbody tr').first()).toContainText('R$ 100,00');
  await table.locator('tbody tr').first().getByRole('button').click();
  await expect(page.getByTestId('opportunity-detail')).toContainText('80.0%');
  await expect(page.getByTestId('opportunity-detail')).toContainText('Unknown future code');
  await expect(page.getByTestId('opportunity-detail')).toContainText('R$ 100,00');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('button', { name: 'Ver High' }).click();
  await page.getByRole('button', { name: 'Próxima' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await page.getByLabel('Selecionar página atual').check();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/revenue-opportunities/);
  await page.getByRole('button', { name: 'Enviar audiência' }).click();
  await expect(page.getByRole('heading', { name: 'Confirme a audiência' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar envio' }).click();
  await expect(page.getByText(/Audiência enviada/)).toBeVisible(); expect(providerWrites).toBe(1);
});

browser('no-money and mixed-currency states stay actionable without false totals', async ({ page }) => {
  await page.getByLabel('Radar de oportunidades').selectOption(RADARS.noMoney.id);
  await expect(page.getByText(/histórico monetário consistente insuficiente/i).first()).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  await expect(page.getByText('Dados ao vivo indisponíveis')).toHaveCount(0);
  await page.getByLabel('Radar de oportunidades').selectOption(RADARS.mixed.id);
  await expect(page.getByText('Múltiplas moedas', { exact: true })).toBeVisible();
  await expect(page.getByText(/escolha uma moeda para comparar/i)).toBeVisible();
  await page.getByLabel('Filtrar moeda').selectOption('BRL');
  await page.getByLabel('Ordenar oportunidades').selectOption('expectedRevenue');
  await expect(page.locator('table tbody tr')).toHaveCount(1);
});

browser('model promotion waits for B scores, switches atomically, and disconnected destination leaves list/CSV usable', async ({ page }) => {
  await page.getByLabel('Radar de oportunidades').selectOption(RADARS.main.id);
  await db.execute(sql`update radar_model_versions set status='retired' where workspace_id=${WS} and id=${RADARS.main.model}`);
  await db.execute(sql`insert into radar_training_requests(workspace_id,id,radar_id,definition_version,idempotency_key,status,correlation_id) values(${WS},'req-model-b',${RADARS.main.id},1,'model-b','succeeded','model-b')`);
  await db.execute(sql`insert into radar_model_versions(workspace_id,id,radar_id,definition_version,training_request_id,target_outcome_definition_id,prediction_window_days,status,estimator_type,feature_schema_version,artifact_bucket,artifact_object_key,artifact_reference,artifact_checksum,cutoff_ranges,data_counts,metrics,calibration,selection_reason,verified_at) values
    (${WS},'model-e2e-b',${RADARS.main.id},1,'req-model-b','purchase',30,'active','logistic_regression','propensity-v1','models','model-b.joblib','supabase://models/model-b.joblib','0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'selected',now())`);
  await db.execute(sql`update radars set current_model_reference='model-e2e-b' where workspace_id=${WS} and id=${RADARS.main.id}`);
  await page.getByLabel('Atualizar oportunidades').click();
  await expect(page.getByText('Atualizando previsões')).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(0);
  const cutoffB = '2026-08-28T00:00:00.000Z';
  await db.execute(sql`insert into radar_score_batches(workspace_id,radar_id,definition_version,model_version_id,scoring_cutoff,status,scored_customer_count,completed_at) values(${WS},${RADARS.main.id},1,'model-e2e-b',${cutoffB},'completed',1,now())`);
  await db.execute(sql`insert into radar_propensity_scores(workspace_id,radar_id,definition_version,model_version_id,customer_id,scoring_cutoff,probability,feature_schema_version,reason_codes,scored_at) values(${WS},${RADARS.main.id},1,'model-e2e-b','main-001',${cutoffB},'0.91','propensity-v1','["high_engagement"]'::jsonb,${cutoffB})`);
  await opportunities.materialize(WS, RADARS.main.id); await page.getByLabel('Atualizar oportunidades').click();
  await expect(page.locator('table tbody tr')).toHaveCount(1); await expect(page.getByText(/model-e2e-b/)).toBeVisible();
  await db.execute(sql`update connector_connections set lifecycle_state='disconnected' where workspace_id=${WS} and id='dest-e2e'`);
  await page.getByLabel('Atualizar oportunidades').click();
  await expect(page.getByText(/Destino desconectado: ativação indisponível/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar audiência' })).toBeDisabled();
  await page.getByLabel('Selecionar página atual').check();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar CSV' }).click(); await download;
});
