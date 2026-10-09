import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4174/' },
  webServer: { command: 'PORT=4174 node scripts/serve.mjs', url: 'http://127.0.0.1:4174/', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
});
