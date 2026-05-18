import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

/**
 * Launch the BUILT electron app and return both the ElectronApplication
 * handle and the first BrowserWindow page. Also wires up console capture so
 * tests can assert "no errors logged".
 */
export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  consoleErrors: string[]
  pageErrors: Error[]
}

export async function launchElectron(): Promise<LaunchedApp> {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

  const app = await electron.launch({
    args: [mainEntry],
    cwd: repoRoot,
    // Ensure dev-only side-paths in the main process don't trigger.
    env: {
      ...process.env,
      // Avoid setting NODE_ENV=production so devTools stays enabled and any
      // dev-mode console diagnostics surface; but DO set a marker so tests
      // can distinguish.
      REELS_E2E: '1'
    }
  })

  const page = await app.firstWindow({ timeout: 10_000 })

  const consoleErrors: string[] = []
  const pageErrors: Error[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err)
  })

  // Wait for renderer DOM to be ready before tests interact with window.electron.
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 })

  return { app, page, consoleErrors, pageErrors }
}
