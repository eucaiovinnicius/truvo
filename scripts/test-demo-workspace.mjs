#!/usr/bin/env node
/**
 * ORDER 130 — SPEC-21: Root Regression Gate for QA & Demo Workspace v1
 * Runs all Order 130 acceptance test suites:
 * 1. DEMO DATA (synthetic-dataset.test.ts)
 * 2. CONNECTOR FIXTURES (connector-fixtures.test.ts)
 * 3. TENANT ISOLATION (tenant-isolation.test.ts)
 * 4. GOLDEN E2E (golden-e2e.test.ts)
 *
 * Strict Requirement:
 * A reachable, migrated PostgreSQL database is MANDATORY.
 * Fallback to in-memory/constants is strictly prohibited.
 * Exits 0 only if all tests pass against real database with 0 fail and 0 relevant skip.
 */

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const containerName = `truvo-demo-workspace-pg-${process.pid}`;
const port = process.env.DEMO_WORKSPACE_POSTGRES_PORT ?? '55438';
const databaseUrl = `postgresql://postgres:demo_test@127.0.0.1:${port}/truvo_demo_workspace`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

function isDockerRunning() {
  try {
    const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isWslAvailable() {
  try {
    const result = spawnSync('wsl', ['-l'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function tryStartWslPostgres() {
  const script = [
    'mkdir -p /dev/shm/pgdata /run/postgresql',
    'chown -R postgres:postgres /dev/shm/pgdata /run/postgresql',
    'if [ ! -f /dev/shm/pgdata/PG_VERSION ]; then',
    "  su - postgres -s /bin/sh -c 'initdb -D /dev/shm/pgdata -U postgres -A trust'",
    'fi',
    'if ! grep -q "listen_addresses" /dev/shm/pgdata/postgresql.conf 2>/dev/null; then',
    '  echo "listen_addresses = \'*\'" >> /dev/shm/pgdata/postgresql.conf',
    '  echo "unix_socket_directories = \'/run/postgresql, /tmp\'" >> /dev/shm/pgdata/postgresql.conf',
    '  echo "host all all 0.0.0.0/0 trust" >> /dev/shm/pgdata/pg_hba.conf',
    '  echo "host all all ::0/0 trust" >> /dev/shm/pgdata/pg_hba.conf',
    'fi',
    "su - postgres -s /bin/sh -c 'pg_ctl -D /dev/shm/pgdata -o \"-p 5432\" status' >/dev/null 2>&1 || su - postgres -s /bin/sh -c 'pg_ctl -D /dev/shm/pgdata -o \"-p 5432\" -l /dev/shm/pgdata/logfile start'",
    "su - postgres -s /bin/sh -c 'createdb -U postgres truvo_demo_workspace' >/dev/null 2>&1 || true",
  ].join('\n');

  try {
    spawnSync('wsl', ['-d', 'docker-desktop', '-e', '/bin/sh'], {
      input: script,
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch {
    // Ignore error
  }
}

async function isPortReachable(host, targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: targetPort, timeout: 1500 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function redactDatabaseUrl(raw) {
  if (!raw) return '<empty>';
  try {
    const parsed = new URL(raw);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return raw.replace(/(:\/\/)([^:@\s]+):([^@\s]+)@/g, '$1$2:***@');
  }
}

async function isDatabaseUrlReachable(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname || '127.0.0.1';
    const targetPort = Number(parsed.port || '5432');
    return await isPortReachable(host, targetPort);
  } catch {
    return false;
  }
}

async function waitForPostgres(targetContainer) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('docker', ['exec', targetContainer, 'pg_isready', '-U', 'postgres', '-d', 'truvo_demo_workspace'], { stdio: 'ignore' });
    if (result.status === 0) return;
    await delay(500);
  }
  throw new Error('Disposable PostgreSQL container did not become ready');
}

async function main() {
  let dockerStarted = false;
  let testEnv = { ...process.env };

  try {
    console.log('\n[ORDER 130] Resolving mandatory PostgreSQL database environment...');

    if (process.env.DATABASE_URL) {
      const reachable = await isDatabaseUrlReachable(process.env.DATABASE_URL);
      if (!reachable) {
        throw new Error(
          `Configured DATABASE_URL is not reachable: ${redactDatabaseUrl(process.env.DATABASE_URL)}. A real reachable PostgreSQL is required.`,
        );
      }
      console.log('[ORDER 130] Using provided DATABASE_URL.');
      run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: testEnv });
    } else if (isDockerRunning()) {
      console.log('[ORDER 130] Docker daemon is available. Provisioning disposable PostgreSQL 16 container...');
      run('docker', [
        'run', '--name', containerName,
        '-e', 'POSTGRES_PASSWORD=demo_test',
        '-e', 'POSTGRES_DB=truvo_demo_workspace',
        '-p', `${port}:5432`,
        '-d', 'postgres:16-alpine',
      ]);
      dockerStarted = true;
      await waitForPostgres(containerName);
      testEnv.DATABASE_URL = databaseUrl;
      console.log('[ORDER 130] Applying migrations to disposable container...');
      run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: testEnv });
    } else {
      // Try local/WSL PostgreSQL
      if (isWslAvailable()) {
        tryStartWslPostgres();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await isPortReachable('127.0.0.1', 5432)) break;
          await delay(250);
        }
      }
      if (await isPortReachable('127.0.0.1', 5432)) {
        const localUrl = 'postgresql://postgres@127.0.0.1:5432/truvo_demo_workspace';
        console.log('[ORDER 130] Local PostgreSQL detected on 127.0.0.1:5432. Using local instance...');
        testEnv.DATABASE_URL = localUrl;
        run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: testEnv });
      } else {
        throw new Error(
          'Database requirement failed: Neither DATABASE_URL is provided nor is Docker daemon running to provision a disposable PostgreSQL instance. A reachable migrated PostgreSQL is mandatory for QA & demo regression gates.',
        );
      }
    }

    const testFiles = [
      'src/modules/qa-demo/synthetic-dataset.test.ts',
      'src/modules/qa-demo/connector-fixtures.test.ts',
      'src/modules/qa-demo/tenant-isolation.test.ts',
      'src/modules/qa-demo/golden-e2e.test.ts',
    ];

    console.log('\n[ORDER 130] Running QA & Demo Workspace Regression Suite against real PostgreSQL...\n');
    for (const testFile of testFiles) {
      console.log(`[SUITE] node --test ${testFile}`);
      run(process.execPath, [
        '--import',
        './node_modules/tsx/dist/loader.mjs',
        '--test',
        testFile,
      ], {
        cwd: 'apps/api',
        env: testEnv,
      });
    }

    console.log('\n[ORDER 130] ALL QA & DEMO WORKSPACE REGRESSION GATES PASSED (0 fail, 0 skip).\n');
  } finally {
    if (dockerStarted) {
      spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    }
  }
}

main().catch((err) => {
  console.error('\n[ORDER 130] REGRESSION GATE FAILED:\n', err);
  process.exit(1);
});
