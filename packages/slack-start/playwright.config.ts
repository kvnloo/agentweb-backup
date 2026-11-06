import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SLACK_START_E2E_PORT ?? 4319);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node e2e/server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
  },
});
