import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: 'pnpm exec next dev --turbo --port 3100',
    cwd: __dirname,
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3101' },
  },
});
