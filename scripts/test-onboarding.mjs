import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const name = `truvo-onboarding-pg-${process.pid}`; const port = process.env.ONBOARDING_POSTGRES_PORT ?? '55441'; const url = `postgresql://postgres:onboarding_test@127.0.0.1:${port}/truvo_onboarding`; const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function run(command, args, options = {}) { const result = spawnSync(command, args, { stdio: 'inherit', ...options }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`); }
let started = false;
try {
  run('docker', ['run','--name',name,'-e','POSTGRES_PASSWORD=onboarding_test','-e','POSTGRES_DB=truvo_onboarding','-p',`${port}:5432`,'-d','postgres:16-alpine']); started = true;
  for (let i=0;i<60;i++) { const ready=spawnSync('docker',['exec',name,'pg_isready','-U','postgres','-d','truvo_onboarding'],{stdio:'ignore'}); if(ready.status===0) break; if(i===59) throw new Error('Postgres not ready'); await delay(500); }
  const env={...process.env,DATABASE_URL:url}; run(pnpm,['--filter','@truvo/db','db:migrate'],{env}); run(pnpm,['--filter','@truvo/db','db:migrate'],{env}); run(pnpm,['--filter','@truvo/api','exec','tsx','--test','src/modules/onboarding/onboarding.runtime.test.ts','src/modules/auth/guards/workspace.guard.test.ts','src/modules/connectors/onboarding-sources.authorization.test.ts'],{env});
  run(pnpm,['--filter','@truvo/web','test'],{env});
  run(pnpm,['--filter','@truvo/web','test:onboarding:e2e'],{env});
} finally { if(started) run('docker',['rm','-f',name]); }
