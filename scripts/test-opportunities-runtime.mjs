import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const suffix = process.pid;
const postgresContainer = `truvo-opportunities-pg-${suffix}`;
const redisContainer = `truvo-opportunities-redis-${suffix}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

function mappedPort(container, containerPort) {
  const result = spawnSync('docker', ['port', container, `${containerPort}/tcp`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot resolve port for ${container}`);
  return result.stdout.trim().match(/:(\d+)$/)?.[1] ?? '';
}

async function ready(container, args) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore' }).status === 0) return;
    await delay(500);
  }
  throw new Error(`${container} did not become ready`);
}

const started = [];
try {
  run('docker', ['run', '--name', postgresContainer, '-e', 'POSTGRES_PASSWORD=opportunity_test', '-e', 'POSTGRES_DB=truvo_opportunities', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']);
  started.push(postgresContainer);
  run('docker', ['run', '--name', redisContainer, '-p', '127.0.0.1::6379', '-d', 'redis:7-alpine']);
  started.push(redisContainer);
  await Promise.all([
    ready(postgresContainer, ['pg_isready', '-U', 'postgres', '-d', 'truvo_opportunities']),
    ready(redisContainer, ['redis-cli', 'ping']),
  ]);
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://postgres:opportunity_test@127.0.0.1:${mappedPort(postgresContainer, 5432)}/truvo_opportunities`,
    REDIS_URL: `redis://127.0.0.1:${mappedPort(redisContainer, 6379)}`,
    OPPORTUNITY_CURSOR_SECRET: 'order-100-runtime-cursor-secret',
  };
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/api', 'test:opportunities'], { env });
  run(pnpm, ['--filter', '@truvo/api', 'test:opportunities:runtime'], { env });
} finally {
  for (const container of started.reverse()) spawnSync('docker', ['rm', '-f', container], { stdio: 'inherit' });
}
