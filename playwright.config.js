import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', timeout: 30000, workers: 1, fullyParallel: false,
  reporter: [['list']], outputDir: 'test-results',
  use: {
    browserName: 'chromium', channel: process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true, viewport: { width: 1280, height: 850 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
