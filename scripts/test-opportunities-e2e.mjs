import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const container = `truvo-opportunities-e2e-pg-${process.pid}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function run(command, args, options = {}) { const result = spawnSync(command, args, { stdio: 'inherit', ...options }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`); }
function port() { const result = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }); return result.stdout.trim().match(/:(\d+)$/)?.[1]; }
try {
  run('docker', ['run', '--name', container, '-e', 'POSTGRES_PASSWORD=e2e_test', '-e', 'POSTGRES_DB=truvo_opportunities_e2e', '-p', '127.0.0.1::5432', '-d', 'postgres:16-alpine']);
  for (let attempt = 0; attempt < 80; attempt += 1) { if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'truvo_opportunities_e2e'], { stdio: 'ignore' }).status === 0) break; await delay(500); }
  const env = { ...process.env, DATABASE_URL: `postgresql://postgres:e2e_test@127.0.0.1:${port()}/truvo_opportunities_e2e`, OPPORTUNITY_CURSOR_SECRET: 'order-100-e2e-cursor-secret' };
  run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env });
  run(pnpm, ['--filter', '@truvo/api', 'build'], { env });
  run(pnpm, ['--filter', '@truvo/web', 'test:opportunities:e2e'], { env });
} finally { spawnSync('docker', ['rm', '-f', container], { stdio: 'inherit' }); }
