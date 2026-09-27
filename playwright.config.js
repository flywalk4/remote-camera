// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8090;

module.exports = defineConfig({
  testDir: 'tests/web',
  timeout: 30_000,
  fullyParallel: false, // one shared mock iPhone
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node tests/web/mock-server.js',
    url: `http://localhost:${PORT}/api/state`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
