import { defineConfig } from '@playwright/test'

/**
 * Playwright config for Reels Studio Electron app.
 *
 * - Tests live in ./e2e/tests
 * - Fixtures (test mp4 etc.) are generated in ./e2e/fixtures by the global setup.
 * - We launch the BUILT app (out/main/index.js) via Playwright's _electron API
 *   inside individual tests; no webServer is needed.
 */
export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  // Electron + ffmpeg jobs are real I/O; give each test a generous budget.
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
