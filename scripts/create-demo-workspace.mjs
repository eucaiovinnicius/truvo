#!/usr/bin/env node
/**
 * ORDER 130 — SPEC-21: Demo Workspace CLI Command
 * Creates or resets a deterministic demo workspace.
 * Usage:
 *   node scripts/create-demo-workspace.mjs [--workspace-id <id>] [--no-reset]
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run through tsx loader if plain node was invoked without loader
const hasTsLoader =
  process.execArgv.some((a) => a.includes('tsx') || a.includes('loader.mjs')) ||
  process.env.__TSX_LOADER_ACTIVE === 'true';

if (!hasTsLoader) {
  const require = createRequire(import.meta.url);
  let loaderPath;
  try {
    loaderPath = require.resolve('tsx', {
      paths: [fileURLToPath(new URL('../apps/api', import.meta.url))],
    });
  } catch {
    try {
      loaderPath = require.resolve('tsx');
    } catch {
      loaderPath = null;
    }
  }

  if (loaderPath) {
    const loaderUrl = pathToFileURL(loaderPath).href;
    const res = spawnSync(
      process.execPath,
      ['--import', loaderUrl, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: { ...process.env, __TSX_LOADER_ACTIVE: 'true' },
      },
    );
    process.exit(res.status ?? 0);
  }
}

const { closeDb, createDb } = await import('../packages/db/src/index.ts');
const {
  createQaDemoWorkspaceService,
  DEMO_WORKSPACE_DEFAULT_ID,
  isReservedDemoWorkspaceId,
} = await import('../apps/api/src/modules/qa-demo/qa-demo-workspace.service.ts');

async function main() {
  const args = process.argv.slice(2);
  let workspaceId = DEMO_WORKSPACE_DEFAULT_ID;
  let cleanBeforeSeed = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace-id' && args[i + 1]) {
      workspaceId = args[i + 1];
      i++;
    } else if (args[i] === '--no-reset') {
      cleanBeforeSeed = false;
    }
  }

  // Safety guard
  if (!isReservedDemoWorkspaceId(workspaceId)) {
    console.error(
      JSON.stringify({
        error: 'Safety violation: Target workspace must be explicitly identified as demo/qa.',
      }),
    );
    process.exit(1);
  }

  const db = createDb();
  try {
    const service = createQaDemoWorkspaceService(db);
    const result = await service.createOrResetDemoWorkspace({
      workspaceId,
      cleanBeforeSeed,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  } finally {
    await closeDb(db).catch(() => undefined);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
