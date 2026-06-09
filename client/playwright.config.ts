import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Build a coverage-instrumented bundle and serve it. (The Rust backend on
  // :3001 must be running separately — it needs DEEPGRAM/GROQ keys.)
  webServer: {
    command: 'COVERAGE=1 PUBLIC_WS_HOST=localhost:3001 npm run build && npx astro preview --port 4321',
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: process.env.E2E_BASE || 'http://localhost:4321',
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--no-sandbox',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
