import { spawnSync } from 'node:child_process';

function run(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with status ${result.status}`);
}

run('scripts/test-opportunities-runtime.mjs');
run('scripts/test-opportunities-e2e.mjs');
