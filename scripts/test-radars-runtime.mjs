import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const containerName = `truvo-radar-runtime-pg-${process.pid}`;
const port = process.env.RADAR_RUNTIME_POSTGRES_PORT ?? '55436';
const databaseUrl = `postgresql://postgres:radar_test@127.0.0.1:${port}/truvo_radar_runtime`;
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

function docker(args, options = {}) {
  run('docker', args, options);
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'truvo_radar_runtime'], { stdio: 'ignore' });
    if (result.status === 0) return;
    await delay(500);
  }
  throw new Error('Disposable PostgreSQL 16 did not become ready');
}

async function main() {
  let started = false;
  try {
    docker([
      'run', '--name', containerName,
      '-e', 'POSTGRES_PASSWORD=radar_test',
      '-e', 'POSTGRES_DB=truvo_radar_runtime',
      '-p', `${port}:5432`,
      '-d', 'postgres:16-alpine',
    ]);
    started = true;
    await waitForPostgres();
    const env = { ...process.env, DATABASE_URL: databaseUrl };
    run(executable, ['--filter', '@truvo/db', 'db:migrate'], { env });
    run(executable, ['exec', 'tsx', '--test', 'src/modules/radars/radar.runtime.test.ts'], { env });
  } finally {
    if (started) {
      const cleanup = spawnSync('docker', ['rm', '-f', containerName], { stdio: 'inherit' });
      if (cleanup.error) throw cleanup.error;
      if (cleanup.status !== 0) throw new Error(`Failed to remove disposable container ${containerName}`);
    }
  }
}

await main();
