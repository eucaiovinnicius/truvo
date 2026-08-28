import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const suffix = process.pid;
const baseline = '3b01c078bb3770eecca442b107a2dbe2aaf7e591';
const releaseCommit = process.env.RELEASE_COMMIT || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const names = Object.fromEntries(['pg', 'redis', 'ch', 'rp', 'api', 'consumer', 'web', 'prior'].map((key) => [key, `truvo-staging-${key}-${suffix}`]));
const network = `truvo-staging-net-${suffix}`;
const imageSuffix = process.env.PREBETA_IMAGE_SUFFIX || suffix;
const images = { api: `truvo-api-prebeta:${imageSuffix}`, prior: `truvo-api-prebeta-prior:${imageSuffix}`, consumer: `truvo-consumer-prebeta:${imageSuffix}`, web: `truvo-web-prebeta:${imageSuffix}`, worker: `truvo-worker-prebeta:${imageSuffix}` };
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const started = [];
const temp = mkdtempSync(join(tmpdir(), 'truvo-prebeta-baseline-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  return result;
}
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function captureAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function port(container, containerPort) {
  const match = capture('docker', ['port', container, `${containerPort}/tcp`]).match(/:(\d+)$/);
  if (!match) throw new Error(`missing mapped port ${container}:${containerPort}`);
  return Number(match[1]);
}
async function ready(container, args) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore' }).status === 0) return;
    await delay(500);
  }
  throw new Error(`${container} did not become ready`);
}
async function getJson(url, expectedStatus = 200) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await requestBody(url);
      if (response.status === expectedStatus) return JSON.parse(response.body);
    } catch { /* retry */ }
    await delay(500);
  }
  throw new Error(`${url} did not return ${expectedStatus}`);
}
async function getOk(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await requestBody(url); if (response.status >= 200 && response.status < 400) return; } catch { /* retry */ }
    await delay(500);
  }
  throw new Error(`${url} did not become healthy`);
}
function requestBody(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error('http_probe_timeout')));
    request.once('error', reject);
  });
}
function productionToken(subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: subject, email: 'prebeta-runtime@example.invalid', aud: 'authenticated', role: 'authenticated', iss: `http://host.docker.internal:${storagePort}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 300 });
  const signature = createHmac('sha256', 'prebeta-jwt-secret-at-least-32-characters').update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
function startApi(name, image, commit) {
  run('docker', ['run', '--name', name, '--network', network, '-p', '127.0.0.1::3333',
    '-e', 'NODE_ENV=production', '-e', 'CORS_ORIGINS=https://staging.truvo.invalid', '-e', 'TRUVO_DEV_AUTH_BYPASS=0',
    '-e', `RELEASE_COMMIT=${commit}`, '-e', 'RELEASE_VERSION=prebeta-staging',
    '-e', 'DATABASE_URL=postgresql://postgres:prebeta_test@pg:5432/truvo_prebeta',
    '-e', 'CLICKHOUSE_URL=http://ch:8123', '-e', 'CLICKHOUSE_USER=truvo', '-e', 'CLICKHOUSE_PASSWORD=truvo_local', '-e', 'CLICKHOUSE_DB=truvo',
    '-e', 'REDIS_URL=redis://redis:6379', '-e', 'KAFKA_BROKERS=rp:29092',
    '-e', `SUPABASE_URL=http://host.docker.internal:${storagePort}`, '-e', 'SUPABASE_SERVICE_ROLE_KEY=prebeta-service-role', '-e', 'SUPABASE_JWT_SECRET=prebeta-jwt-secret-at-least-32-characters',
    '-e', 'INTERNAL_API_SECRET=prebeta-internal-secret', '-d', image]);
  started.push(name);
}

const objects = new Map();
const storage = createServer((request, response) => {
  const path = request.url ?? '/';
  if (request.method === 'GET' && path === '/storage/v1/bucket/models') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'models', name: 'models', public: false })); return;
  }
  if (path.startsWith('/storage/v1/object/models/')) {
    const key = path.slice('/storage/v1/object/models/'.length);
    if (request.method === 'POST') {
      const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { objects.set(key, Buffer.concat(chunks)); response.writeHead(200); response.end('{}'); }); return;
    }
    const value = objects.get(key);
    if (!value) { response.writeHead(404); response.end(); return; }
    if (request.method === 'HEAD') { response.writeHead(200, { 'content-length': value.length, 'x-truvo-sha256': request.headers['x-truvo-sha256'] ?? '' }); response.end(); return; }
    response.writeHead(200, { 'content-length': value.length }); response.end(value); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((resolve, reject) => { storage.once('error', reject); storage.listen(0, '0.0.0.0', resolve); });
const storageAddress = storage.address();
if (!storageAddress || typeof storageAddress === 'string') throw new Error('storage harness failed');
const storagePort = storageAddress.port;

try {
  run('docker', ['network', 'create', network]);
  run('docker', ['run', '--name', names.pg, '--network', network, '--network-alias', 'pg', '-e', 'POSTGRES_PASSWORD=prebeta_test', '-e', 'POSTGRES_DB=truvo_prebeta', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']); started.push(names.pg);
  run('docker', ['run', '--name', names.redis, '--network', network, '--network-alias', 'redis', '-p', '127.0.0.1::6379', '-d', 'redis:7-alpine']); started.push(names.redis);
  run('docker', ['run', '--name', names.ch, '--network', network, '--network-alias', 'ch', '-e', 'CLICKHOUSE_DB=truvo', '-e', 'CLICKHOUSE_USER=truvo', '-e', 'CLICKHOUSE_PASSWORD=truvo_local', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1', '-p', '127.0.0.1::8123', '-d', 'clickhouse/clickhouse-server:24.8-alpine']); started.push(names.ch);
  run('docker', ['run', '--name', names.rp, '--network', network, '--network-alias', 'rp', '-d', 'redpandadata/redpanda:v24.2.4', 'redpanda', 'start', '--smp=1', '--overprovisioned', '--node-id=0', '--kafka-addr=0.0.0.0:29092', '--advertise-kafka-addr=rp:29092', '--check=false']); started.push(names.rp);
  await Promise.all([ready(names.pg, ['pg_isready', '-U', 'postgres', '-d', 'truvo_prebeta']), ready(names.redis, ['redis-cli', 'ping']), ready(names.ch, ['wget', '--spider', '-q', '127.0.0.1:8123/ping']), ready(names.rp, ['rpk', 'cluster', 'health'])]);
  const hostEnv = { ...process.env, DATABASE_URL: `postgresql://postgres:prebeta_test@127.0.0.1:${port(names.pg, 5432)}/truvo_prebeta`, CLICKHOUSE_URL: `http://127.0.0.1:${port(names.ch, 8123)}`, CLICKHOUSE_USER: 'truvo', CLICKHOUSE_PASSWORD: 'truvo_local', CLICKHOUSE_DB: 'truvo' };
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: hostEnv });
  run(pnpm, ['--filter', '@truvo/db', 'ch:migrate'], { env: hostEnv });
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: hostEnv });

  if (process.env.PREBETA_SKIP_IMAGE_BUILD !== '1') {
    run('docker', ['build', '-f', 'apps/api/Dockerfile', '-t', images.api, '.']);
    run('docker', ['build', '-f', 'apps/consumer/Dockerfile', '-t', images.consumer, '.']);
    run('docker', ['build', '-f', 'apps/propensity-worker/Dockerfile', '-t', images.worker, 'apps/propensity-worker']);
    run('docker', ['build', '-f', 'apps/web/Dockerfile', '--build-arg', 'NEXT_PUBLIC_API_URL=http://localhost:3333', '-t', images.web, '.']);
    run('git', ['archive', '--format=tar', '-o', join(temp, 'baseline.tar'), baseline]);
    run('tar', ['-xf', join(temp, 'baseline.tar'), '-C', temp]);
    run('docker', ['build', '-f', join(temp, 'apps/api/Dockerfile'), '-t', images.prior, temp]);
  }

  startApi(names.api, images.api, releaseCommit);
  const apiPort = port(names.api, 3333);
  console.log(`[staging] waiting for current API on ${apiPort}`);
  const live = await getJson(`http://127.0.0.1:${apiPort}/health`);
  if (live.release?.commit !== releaseCommit) throw new Error('current release identity mismatch');
  console.log('[staging] current liveness and release identity passed');
  const readyCurrent = await getJson(`http://127.0.0.1:${apiPort}/health/ready`);
  if (readyCurrent.status !== 'ready' || Object.values(readyCurrent.checks).some((value) => value !== 'ok')) throw new Error(`unhealthy staging: ${JSON.stringify(readyCurrent)}`);
  await getJson(`http://127.0.0.1:${apiPort}/health/metrics`);
  console.log('[staging] dependency readiness and metrics passed');

  const authUser = '11500000-0000-4000-8000-000000000001';
  const authWorkspace = '11500000-0000-4000-8000-000000000002';
  run('docker', ['exec', names.pg, 'psql', '-U', 'postgres', '-d', 'truvo_prebeta', '-v', 'ON_ERROR_STOP=1', '-c', `insert into users(id,email) values('${authUser}','prebeta-runtime@example.invalid'); insert into workspaces(id,name,slug,created_by) values('${authWorkspace}','Prebeta Runtime','prebeta-runtime','${authUser}'); insert into workspace_members(workspace_id,user_id,role,status) values('${authWorkspace}','${authUser}','owner','active');`]);
  const authenticated = await requestBody(`http://127.0.0.1:${apiPort}/v1/workspaces`, { headers: { authorization: `Bearer ${productionToken(authUser)}` } });
  if (authenticated.status !== 200 || !JSON.parse(authenticated.body).some((workspace) => workspace.id === authWorkspace)) throw new Error(`production auth request failed: ${authenticated.status} ${authenticated.body}`);
  console.log('[staging] production JWT API request passed with dev bypass disabled');

  run('docker', ['run', '--name', names.consumer, '--network', network, '-e', 'KAFKA_BROKERS=rp:29092', '-e', 'REDIS_URL=redis://redis:6379', '-e', 'CLICKHOUSE_URL=http://ch:8123', '-e', 'CLICKHOUSE_USER=truvo', '-e', 'CLICKHOUSE_PASSWORD=truvo_local', '-e', 'CLICKHOUSE_DB=truvo', '-d', images.consumer]); started.push(names.consumer);
  await delay(2_000);
  if (!capture('docker', ['logs', names.consumer]).includes('consumer_ready')) throw new Error('consumer production process not ready');
  console.log('[staging] consumer process passed');

  run('docker', ['run', '--name', names.web, '--network', network, '-p', '127.0.0.1::3000', '-d', images.web]); started.push(names.web);
  const webPort = port(names.web, 3000);
  await getOk(`http://127.0.0.1:${webPort}/`);
  console.log('[staging] web process passed');

  const dispatch = JSON.stringify({ workspaceId: 'prebeta', radarId: 'radar', definitionVersion: 1, trainingRequestId: 'missing', correlationId: 'prebeta-worker-entrypoint' });
  const worker = await captureAsync('docker', ['run', '--rm', '--network', network,
    '-e', 'DATABASE_URL=postgresql://postgres:prebeta_test@pg:5432/truvo_prebeta', '-e', `SUPABASE_URL=http://host.docker.internal:${storagePort}`,
    '-e', 'SUPABASE_SERVICE_ROLE_KEY=prebeta-service-role', '-e', 'PROPENSITY_ARTIFACT_BUCKET=models', '-e', 'INTERNAL_API_SECRET=prebeta-internal-secret',
    images.worker, 'python', '-m', 'propensity_worker', '--once-json', dispatch]);
  if (worker.status !== 0 || !worker.stdout.includes('not_found')) throw new Error(`worker entrypoint did not execute: ${worker.stderr}${worker.stdout}`);
  const unsafeWorker = await captureAsync('docker', ['run', '--rm', '--network', network, '-e', 'DATABASE_URL=postgresql://postgres:prebeta_test@pg:5432/truvo_prebeta', images.worker, 'python', '-m', 'propensity_worker', '--once-json', dispatch]);
  if (unsafeWorker.status === 0 || !`${unsafeWorker.stderr}${unsafeWorker.stdout}`.includes('SUPABASE_URL is required')) throw new Error('worker did not fail closed without artifact verification configuration');
  console.log('[staging] worker image entrypoint and fail-closed configuration passed');

  run('docker', ['stop', names.redis]);
  const redisDown = await getJson(`http://127.0.0.1:${apiPort}/health/ready`);
  if (redisDown.checks?.redis !== 'down' || redisDown.status !== 'ready') throw new Error('Redis degradation not truthful');
  run('docker', ['start', names.redis]); await ready(names.redis, ['redis-cli', 'ping']);
  run('docker', ['stop', names.rp]);
  const kafkaDown = await getJson(`http://127.0.0.1:${apiPort}/health/ready`);
  if (kafkaDown.checks?.kafka !== 'down' || kafkaDown.status !== 'ready') throw new Error('Kafka degradation not truthful');
  run('docker', ['start', names.rp]); await ready(names.rp, ['rpk', 'cluster', 'health']);

  run('docker', ['rm', '-f', names.api]); started.splice(started.indexOf(names.api), 1);
  startApi(names.prior, images.prior, baseline);
  const priorPort = port(names.prior, 3333);
  const priorHealth = await getJson(`http://127.0.0.1:${priorPort}/health`);
  if (priorHealth.release?.commit !== baseline) throw new Error('prior release identity mismatch');
  await getJson(`http://127.0.0.1:${priorPort}/health/ready`);
  run('docker', ['rm', '-f', names.prior]); started.splice(started.indexOf(names.prior), 1);
  startApi(names.api, images.api, releaseCommit);
  const restoredPort = port(names.api, 3333);
  const restored = await getJson(`http://127.0.0.1:${restoredPort}/health/ready`);
  if (restored.status !== 'ready') throw new Error('current release did not recover after rollback proof');
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: hostEnv });
  console.log(JSON.stringify({ staging: 'pass', releaseCommit, baselineRollback: baseline, workerImage: 'pass', health: restored }, null, 2));
} finally {
  storage.close();
  for (const container of [...started].reverse()) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  if (process.env.PREBETA_KEEP_IMAGES !== '1') for (const image of Object.values(images)) spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore' });
  rmSync(temp, { recursive: true, force: true });
}
