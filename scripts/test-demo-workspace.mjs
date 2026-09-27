#!/usr/bin/env node
/**
 * ORDER 130 — SPEC-21: Root Regression Gate for QA & Demo Workspace v1
 * Runs all Order 130 acceptance test suites:
 * 1. DEMO DATA (synthetic-dataset.test.ts)
 * 2. CONNECTOR FIXTURES (connector-fixtures.test.ts)
 * 3. TENANT ISOLATION (tenant-isolation.test.ts)
 * 4. GOLDEN E2E (golden-e2e.test.ts)
 *
 * Exits 0 only if all tests pass with 0 fail and 0 relevant skip.
 */

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

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

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'truvo_demo_workspace'], { stdio: 'ignore' });
    if (result.status === 0) return;
    await delay(500);
  }
  throw new Error('Disposable PostgreSQL container did not become ready');
}

async function main() {
  let dockerStarted = false;
  let testEnv = { ...process.env };

  try {
    if (!process.env.DATABASE_URL && isDockerRunning()) {
      run('docker', [
        'run', '--name', containerName,
        '-e', 'POSTGRES_PASSWORD=demo_test',
        '-e', 'POSTGRES_DB=truvo_demo_workspace',
        '-p', `${port}:5432`,
        '-d', 'postgres:16-alpine',
      ]);
      dockerStarted = true;
      await waitForPostgres();
      testEnv.DATABASE_URL = databaseUrl;
      run(pnpm, ['--filter', '@truvo/db', 'db:migrate'], { env: testEnv });
    }

    const testFiles = [
      'src/modules/qa-demo/synthetic-dataset.test.ts',
      'src/modules/qa-demo/connector-fixtures.test.ts',
      'src/modules/qa-demo/tenant-isolation.test.ts',
      'src/modules/qa-demo/golden-e2e.test.ts',
    ];

    console.log('\n[ORDER 130] Running QA & Demo Workspace Regression Suite...\n');
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
