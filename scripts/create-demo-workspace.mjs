#!/usr/bin/env node
/**
 * ORDER 130 — SPEC-21: Demo Workspace CLI Command
 * Creates or resets a deterministic demo workspace.
 * Usage:
 *   node scripts/create-demo-workspace.mjs [--workspace-id <id>] [--reset]
 */

import { closeDb, createDb } from '@truvo/db';
import { createQaDemoWorkspaceService } from '../apps/api/src/modules/qa-demo/qa-demo-workspace.service.ts';
import { DEMO_WORKSPACE_DEFAULT_ID } from '../apps/api/src/modules/qa-demo/qa-demo-workspace.service.ts';

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
  if (!workspaceId.includes('demo') && !workspaceId.includes('qa') && !workspaceId.startsWith('00000000-0000-4000-8000-')) {
    console.error(JSON.stringify({
      error: 'Safety violation: Target workspace must be explicitly identified as demo/qa.',
    }));
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
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  } finally {
    await closeDb(db).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
