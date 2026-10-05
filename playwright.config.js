import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  use: {
    browserName: 'chromium',
    headless: false,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'es-CR',
    timezoneId: 'America/Costa_Rica'
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'data/playwright-report', open: 'never' }]
  ]
});
