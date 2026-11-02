import { defineConfig } from '@playwright/test';

// The app is expected to be running (docker compose up). Tests never start a server
// themselves, so the exact artefact under test is the one the pipeline deployed.
// Headless only: no window is ever opened on a developer's desktop.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['json', { outputFile: 'artifacts/playwright.json' }], ['list']],
  use: {
    baseURL: process.env.APP_URL || 'http://127.0.0.1:8080',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
