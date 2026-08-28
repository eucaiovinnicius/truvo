import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const suffix = process.pid;
const pg = `truvo-prebeta-pg-${suffix}`;
const redpanda = `truvo-prebeta-rp-${suffix}`;
const redis = `truvo-prebeta-redis-${suffix}`;
const clickhouse = `truvo-prebeta-ch-${suffix}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function mappedPort(container, containerPort) {
  const result = spawnSync('docker', ['port', container, `${containerPort}/tcp`], { encoding: 'utf8' });
  const match = result.stdout.trim().match(/:(\d+)$/);
  if (result.status !== 0 || !match) throw new Error(`cannot resolve ${container}:${containerPort}`);
  return Number(match[1]);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no free port'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function ready(container, args) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore' }).status === 0) return;
    await delay(500);
  }
  throw new Error(`${container} did not become ready`);
}

const started = [];
try {
  const kafkaPort = await freePort();
  run('docker', ['run', '--name', pg, '-e', 'POSTGRES_PASSWORD=prebeta_test', '-e', 'POSTGRES_DB=truvo_prebeta', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']);
  started.push(pg);
  run('docker', ['run', '--name', redpanda, '-p', `127.0.0.1:${kafkaPort}:9092`, '-d', 'redpandadata/redpanda:v24.2.4', 'redpanda', 'start', '--smp=1', '--overprovisioned', '--node-id=0', '--kafka-addr=0.0.0.0:9092', `--advertise-kafka-addr=127.0.0.1:${kafkaPort}`, '--check=false']);
  started.push(redpanda);
  run('docker', ['run', '--name', redis, '-p', '127.0.0.1::6379', '-d', 'redis:7-alpine']);
  started.push(redis);
  run('docker', ['run', '--name', clickhouse, '-e', 'CLICKHOUSE_DB=truvo', '-e', 'CLICKHOUSE_USER=truvo', '-e', 'CLICKHOUSE_PASSWORD=truvo_local', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1', '-p', '127.0.0.1::8123', '-d', 'clickhouse/clickhouse-server:24.8-alpine']);
  started.push(clickhouse);
  await Promise.all([
    ready(pg, ['pg_isready', '-U', 'postgres', '-d', 'truvo_prebeta']),
    ready(redpanda, ['rpk', 'cluster', 'health']),
    ready(redis, ['redis-cli', 'ping']),
    ready(clickhouse, ['wget', '--spider', '-q', '127.0.0.1:8123/ping']),
  ]);
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://postgres:prebeta_test@127.0.0.1:${mappedPort(pg, 5432)}/truvo_prebeta`,
    KAFKA_BROKERS: `127.0.0.1:${kafkaPort}`,
    REDIS_URL: `redis://127.0.0.1:${mappedPort(redis, 6379)}`,
    CLICKHOUSE_URL: `http://127.0.0.1:${mappedPort(clickhouse, 8123)}`,
    CLICKHOUSE_USER: 'truvo',
    CLICKHOUSE_PASSWORD: 'truvo_local',
    CLICKHOUSE_DB: 'truvo',
  };
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/db', 'ch:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/api', 'exec', 'tsx', '--test', 'src/prebeta/prebeta.runtime.test.ts', 'src/prebeta/golden-path.runtime.test.ts'], { env });
  run(pnpm, ['--filter', '@truvo/api', 'test'], { env });
} finally {
  for (const container of started.reverse()) spawnSync('docker', ['rm', '-f', container], { stdio: 'inherit' });
}

if (process.env.PREBETA_FOCUSED_ONLY !== '1') {
  run(pnpm, ['test:propensity']);
  run(pnpm, ['test:opportunities']);
  run(pnpm, ['test:decisions']);
  run(pnpm, ['test:prebeta:staging']);
}
