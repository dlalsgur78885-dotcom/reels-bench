import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
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
  /** Temporary user-data directory created for this launch — removed on close. */
  userDataDir: string
}

export interface LaunchOptions {
  /**
   * Whether to pre-seed a fake Supabase session in localStorage before the
   * renderer mounts. Defaults to `true` so the auth gate added in Phase 3
   * doesn't gate every existing test. Set to `false` to verify the login
   * screen / auth flow itself.
   */
  seedFakeSession?: boolean
}

const SUPABASE_PROJECT_HOSTNAME_PREFIX = 'mrpbovbxtablvawszhey'
const FAKE_SESSION_STORAGE_KEY = `sb-${SUPABASE_PROJECT_HOSTNAME_PREFIX}-auth-token`

/**
 * Build a fake Supabase session blob that's "good enough" for the renderer
 * to consider the user logged-in. The shape mirrors what
 * `@supabase/auth-js` writes to localStorage — see GoTrueClient.persistSession.
 *
 * The access_token is a syntactically-valid JWT (header.payload.sig — sig is
 * bogus). The renderer never validates the signature; it only decodes the
 * payload to extract `sub` for the user_id. The expires_at is set to ~24h
 * in the future so the auto-refresh routine doesn't fire.
 */
function buildFakeSessionBlob(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: '00000000-0000-0000-0000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'e2e@reels-bench.local',
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60
    })
  ).toString('base64url')
  const sig = 'e2e-fake-signature'
  const access_token = `${header}.${payload}.${sig}`
  const session = {
    access_token,
    token_type: 'bearer',
    expires_in: 24 * 60 * 60,
    expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    refresh_token: 'e2e-fake-refresh',
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'e2e@reels-bench.local',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString()
    }
  }
  return JSON.stringify(session)
}

export async function launchElectron(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const seedFakeSession = opts.seedFakeSession ?? true
  const repoRoot = path.resolve(__dirname, '..', '..')
  const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

  // Each test gets its own user-data directory so Electron's
  // requestSingleInstanceLock() does not block the next launch.
  // The dir is written under os.tmpdir() and cleaned up in afterEach
  // when the app is closed (Electron removes its own lock file on exit).
  const uniqueUserData = path.join(
    os.tmpdir(),
    `reels-e2e-${crypto.randomBytes(6).toString('hex')}`
  )
  fs.mkdirSync(uniqueUserData, { recursive: true })

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${uniqueUserData}`],
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

  if (!seedFakeSession) {
    // Electron persists localStorage in userData across launches. Make sure
    // a previous test's session doesn't bleed into a test that wants a
    // pristine "no session" state.
    await page.addInitScript(({ key }: { key: string }) => {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }, { key: FAKE_SESSION_STORAGE_KEY })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
  }

  if (seedFakeSession) {
    // Inject a Supabase session blob into localStorage. AddInitScript fires
    // on EVERY navigation including the initial document load — by the time
    // our `main.tsx` calls `useAuthStore.getState().hydrate()`, localStorage
    // already has the fake session.
    //
    // Important: the renderer's `supabase.auth.getSession()` will pull this
    // blob and treat the user as logged in. The fake JWT is unsigned so any
    // CALL TO THE BACKEND will fail — tests that need backend calls must
    // mock fetch separately.
    const blob = buildFakeSessionBlob()
    await page.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        try {
          window.localStorage.setItem(key, value)
        } catch {
          /* ignore — sandbox may have rejected; test will see Login screen */
        }
      },
      { key: FAKE_SESSION_STORAGE_KEY, value: blob }
    )
    // Stub out the Supabase REST + auth endpoints so the fake JWT doesn't
    // trigger 401 console.errors. Tests that need to exercise the real Auth
    // surface should pass `seedFakeSession: false`.
    await page.route('**/mrpbovbxtablvawszhey.supabase.co/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/rest/v1/profiles')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000001',
            email: 'e2e@reels-bench.local',
            display_name: 'E2E',
            role: 'admin',
            active: true
          })
        })
        return
      }
      // Default: succeed with an empty body so the auth client doesn't log
      // a 401/404 error to the console during boot.
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    // Reload so the init-script runs on a fresh document (since the page
    // already loaded once during launch).
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
  }

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

  return { app, page, consoleErrors, pageErrors, userDataDir: uniqueUserData }
}

export { FAKE_SESSION_STORAGE_KEY, buildFakeSessionBlob }
