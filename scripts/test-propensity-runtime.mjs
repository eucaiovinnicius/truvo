import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { request as httpRequestRaw } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const suffix = process.pid;
const postgresContainer = `truvo-propensity-pg-${suffix}`;
const redisContainer = `truvo-propensity-redis-${suffix}`;
const storagePostgresContainer = `truvo-propensity-storage-pg-${suffix}`;
const storageApiContainer = `truvo-propensity-storage-api-${suffix}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const python = process.env.PROPENSITY_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
const storageJwtSecret = 'propensity-storage-test-secret-at-least-32-chars';
const base64url = (value) => Buffer.from(value).toString('base64url');
const jwtUnsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: 'supabase', role: 'service_role', iat: 1700000000, exp: 2000000000 }))}`;
const storageServiceKey = `${jwtUnsigned}.${createHmac('sha256', storageJwtSecret).update(jwtUnsigned).digest('base64url')}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

function mappedPort(container, containerPort) {
  const result = spawnSync('docker', ['port', container, `${containerPort}/tcp`], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot resolve mapped port for ${container}:${containerPort}`);
  const match = result.stdout.trim().match(/:(\d+)$/);
  if (!match) throw new Error(`Invalid mapped port for ${container}:${containerPort}`);
  return match[1];
}

async function ready(container, args) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore' }).status === 0) return;
    await delay(500);
  }
  throw new Error(`${container} did not become ready`);
}

function httpRequest(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequestRaw(url, options, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject); request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
    if (body) request.write(body); request.end();
  });
}

async function readyHttp(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await httpRequest(url)) < 500) return; } catch { /* retry */ }
    await delay(500);
  }
  throw new Error(`${url} did not become ready`);
}

async function main() {
  const started = [];
  try {
    run('docker', ['run', '--name', postgresContainer, '-e', 'POSTGRES_PASSWORD=propensity_test', '-e', 'POSTGRES_DB=truvo_propensity_runtime', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']);
    started.push(postgresContainer);
    const postgresPort = mappedPort(postgresContainer, 5432);
    const databaseUrl = `postgresql://postgres:propensity_test@127.0.0.1:${postgresPort}/truvo_propensity_runtime`;
    run('docker', ['run', '--name', redisContainer, '-p', '127.0.0.1::6379', '-d', 'redis:7-alpine']);
    started.push(redisContainer);
    const redisPort = mappedPort(redisContainer, 6379);
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    run('docker', ['run', '--name', storagePostgresContainer, '-e', 'POSTGRES_PASSWORD=storage_test', '-e', 'POSTGRES_DB=storage_test', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']);
    started.push(storagePostgresContainer);
    const storagePostgresPort = mappedPort(storagePostgresContainer, 5432);
    await Promise.all([
      ready(postgresContainer, ['pg_isready', '-U', 'postgres', '-d', 'truvo_propensity_runtime']),
      ready(redisContainer, ['redis-cli', 'ping']),
      ready(storagePostgresContainer, ['pg_isready', '-U', 'postgres', '-d', 'storage_test']),
    ]);
    run('docker', [
      'run', '--name', storageApiContainer,
      '-e', 'SERVER_PORT=5000', '-e', `AUTH_JWT_SECRET=${storageJwtSecret}`, '-e', 'AUTH_JWT_ALGORITHM=HS256',
      '-e', `DATABASE_URL=postgresql://postgres:storage_test@host.docker.internal:${storagePostgresPort}/storage_test`,
      '-e', 'DB_INSTALL_ROLES=true', '-e', 'STORAGE_BACKEND=file', '-e', 'FILE_STORAGE_BACKEND_PATH=/var/lib/storage',
      '-e', 'TENANT_ID=stub', '-e', 'REGION=stub', '-e', 'GLOBAL_S3_BUCKET=stub', '-e', 'FILE_SIZE_LIMIT=52428800',
      '-e', 'UPLOAD_FILE_SIZE_LIMIT=52428800', '-e', 'UPLOAD_FILE_SIZE_LIMIT_STANDARD=52428800',
      '-p', '127.0.0.1::5000', '-d', 'supabase/storage-api:v1.23.0',
    ]);
    started.push(storageApiContainer);
    const storageApiPort = mappedPort(storageApiContainer, 5000);
    await readyHttp(`http://127.0.0.1:${storageApiPort}/status`);
    const bucketBody = JSON.stringify({ id: 'propensity-models', name: 'propensity-models', public: false });
    const bucketStatus = await httpRequest(`http://127.0.0.1:${storageApiPort}/bucket`, {
      method: 'POST', headers: { authorization: `Bearer ${storageServiceKey}`, apikey: storageServiceKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bucketBody) },
    }, bucketBody);
    if (bucketStatus < 200 || bucketStatus >= 300) throw new Error(`Failed to create private Storage bucket: ${bucketStatus}`);
    const env = {
      ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, PROPENSITY_PYTHONPATH: 'apps/propensity-worker',
      PROPENSITY_STORAGE_TEST_URL: `http://127.0.0.1:${storageApiPort}`,
      PROPENSITY_STORAGE_TEST_SERVICE_KEY: storageServiceKey,
    };
    run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
    run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
    run(python, ['-m', 'unittest', 'discover', '-s', 'apps/propensity-worker/tests', '-t', 'apps/propensity-worker', '-v'], { env });
    run(pnpm, ['--filter', '@truvo/api', 'test:propensity:contracts'], { env });
    run(pnpm, ['--filter', '@truvo/api', 'exec', 'tsx', '--test', 'src/modules/radars/radar.runtime.test.ts', 'src/modules/radars/propensity.scheduler.runtime.test.ts'], { env });
  } finally {
    for (const container of started.reverse()) {
      const cleanup = spawnSync('docker', ['rm', '-f', container], { stdio: 'inherit' });
      if (cleanup.error) throw cleanup.error;
      if (cleanup.status !== 0) throw new Error(`Failed to remove disposable container ${container}`);
    }
  }
}

await main();
