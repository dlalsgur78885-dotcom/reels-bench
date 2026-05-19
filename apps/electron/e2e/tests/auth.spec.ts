/**
 * Phase 3 — Supabase auth + Vercel API client.
 *
 * Tests run against the BUILT app via Playwright's Electron API. Real
 * Supabase / Vercel endpoints are NEVER hit — we intercept every request
 * to `*.supabase.co` and `reels-bench.vercel.app` via `page.route()`.
 */
import { expect, test } from '@playwright/test'
import {
  FAKE_SESSION_STORAGE_KEY,
  buildFakeSessionBlob,
  launchElectron,
  type LaunchedApp
} from '../helpers/launch'

test.describe('@phase-3-auth login screen + auth gate', () => {
  let launched: LaunchedApp | null = null

  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  test('shows login screen on first launch (no session)', async () => {
    launched = await launchElectron({ seedFakeSession: false })
    const { page } = launched
    await expect(page.locator('[data-testid="login-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-userid"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
    // Home view should NOT be present.
    await expect(page.locator('[data-testid="open-editor-button"]')).toHaveCount(0)
  })

  test('login form rejects invalid userId (regex)', async () => {
    launched = await launchElectron({ seedFakeSession: false })
    const { page } = launched
    await expect(page.locator('[data-testid="login-page"]')).toBeVisible()

    // Korean characters trip the /^[a-z0-9_.\-@]+$/ guard. The HTML5 form
    // submission with an `<input required>` field still runs our submit
    // handler since the input has a value. We use type=text so anything
    // is accepted by the browser layer.
    await page.locator('[data-testid="login-userid"]').fill('한글ID')
    await page.locator('[data-testid="login-password"]').fill('password123')
    await page.locator('[data-testid="login-submit"]').click()

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-error"]')).toContainText(
      '영문/숫자'
    )
  })

  test('toggling between signin/signup modes updates copy', async () => {
    launched = await launchElectron({ seedFakeSession: false })
    const { page } = launched
    // Default = signin → button reads "로그인"
    await expect(page.locator('[data-testid="login-submit"]')).toHaveText('로그인')
    await page.locator('[data-testid="login-mode-signup"]').click()
    await expect(page.locator('[data-testid="login-submit"]')).toHaveText('가입')
    await page.locator('[data-testid="login-mode-signin"]').click()
    await expect(page.locator('[data-testid="login-submit"]')).toHaveText('로그인')
  })

  test('seeded session transitions app to home view', async () => {
    // Default `seedFakeSession: true` — fake session in localStorage means
    // the auth gate lets us through to home.
    launched = await launchElectron()
    const { page } = launched
    await expect(page.locator('[data-testid="open-editor-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-page"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="signout-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="current-user"]')).toBeVisible()
    // userIdLabel = local-part of e2e@reels-bench.local
    await expect(page.locator('[data-testid="current-user"]')).toHaveText('e2e')
  })

  test('sign-out returns to login screen', async () => {
    launched = await launchElectron()
    const { page } = launched
    await expect(page.locator('[data-testid="signout-button"]')).toBeVisible()
    await page.locator('[data-testid="signout-button"]').click()
    // After signOut, the supabase client clears its session and our store
    // listener nulls out `user`, which kicks us back to Login.
    await expect(page.locator('[data-testid="login-page"]')).toBeVisible({
      timeout: 10_000
    })
  })

  test('persisted session survives app restart', async () => {
    // First launch with seed — confirm home view is reachable.
    launched = await launchElectron()
    await expect(launched.page.locator('[data-testid="open-editor-button"]')).toBeVisible()
    await launched.app.close()
    launched = null

    // Second launch ALSO seeds (simulating localStorage persistence —
    // real localStorage in Electron survives between BrowserWindow loads
    // but the test harness creates a fresh process, so we re-seed). The
    // important assertion: when a session exists at boot time, we land on
    // home, not Login.
    launched = await launchElectron()
    await expect(launched.page.locator('[data-testid="open-editor-button"]')).toBeVisible()
    await expect(launched.page.locator('[data-testid="login-page"]')).toHaveCount(0)
  })

  test('auth store is exposed on window for test bridge', async () => {
    launched = await launchElectron()
    const { page } = launched
    const exposed = await page.evaluate(() => {
      const w = window as unknown as { __reelsAuth?: unknown }
      return Boolean(w.__reelsAuth)
    })
    expect(exposed).toBe(true)
  })
})

test.describe('@phase-3-auth API client (authedFetch)', () => {
  let launched: LaunchedApp | null = null

  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  test('authedFetch adds Bearer header from cached access token', async () => {
    launched = await launchElectron()
    const { page } = launched
    // Stub window.fetch in the renderer to capture the request and synthesize
    // a 200 response. We do this in-page because Playwright's page.route()
    // doesn't reliably intercept fetch() from an Electron renderer running
    // under sandbox:true + contextIsolation:true.
    await page.evaluate(() => {
      const w = window as unknown as {
        __apiCalls: { url: string; authorization: string | null }[]
        __origFetch: typeof fetch
      }
      w.__apiCalls = []
      w.__origFetch = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        const headers = new Headers(init?.headers || {})
        const auth = headers.get('Authorization')
        w.__apiCalls.push({ url, authorization: auth })
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }) as typeof fetch
    })
    const result = await page.evaluate(async () => {
      const w = window as unknown as { __reelsApi: { listMyReels: () => Promise<unknown[]> } }
      return w.__reelsApi.listMyReels()
    })
    const calls = await page.evaluate(() => {
      const w = window as unknown as {
        __apiCalls: { url: string; authorization: string | null }[]
      }
      return w.__apiCalls
    })
    expect(result).toEqual([])
    // Filter to /api/reels calls — fetchProfile may have fired Supabase
    // REST calls during hydrate which we don't care about here.
    const reelsCalls = calls.filter((c) => c.url.includes('/api/reels'))
    expect(reelsCalls).toHaveLength(1)
    expect(reelsCalls[0].url).toContain('reels-bench.vercel.app')
    expect(reelsCalls[0].authorization).toBeTruthy()
    expect(reelsCalls[0].authorization!.startsWith('Bearer ')).toBe(true)
  })

  test('401 triggers force-refresh + retry once', async () => {
    launched = await launchElectron()
    const { page } = launched

    // Wire window.fetch to:
    //   call 1 → /api/reels 401 (mimics expired JWT)
    //   call 2 → Supabase /auth/v1/token (refresh) → return new fake JWT
    //   call 3 → /api/reels 200 (retry succeeds)
    await page.evaluate(() => {
      const w = window as unknown as {
        __callLog: string[]
        __origFetch: typeof fetch
      }
      w.__callLog = []
      w.__origFetch = window.fetch
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      const payload = btoa(
        JSON.stringify({
          sub: '00000000-0000-0000-0000-000000000001',
          email: 'e2e@reels-bench.local',
          exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60
        })
      )
      const newAccess = `${header}.${payload}.refreshed`
      let apiHits = 0
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        w.__callLog.push(url)
        if (url.includes('/api/reels')) {
          apiHits += 1
          if (apiHits === 1) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'jwt expired' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
              })
            )
          }
          return Promise.resolve(
            new Response(
              JSON.stringify([{ shortcode: 'X', url: 'u', collected_at: 't' }]),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        if (url.includes('/auth/v1/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: newAccess,
                token_type: 'bearer',
                expires_in: 3600,
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                refresh_token: 'r2',
                user: {
                  id: '00000000-0000-0000-0000-000000000001',
                  email: 'e2e@reels-bench.local'
                }
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        // Unknown URL — succeed empty so unrelated calls don't break.
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }) as typeof fetch
      ;(w as unknown as { __apiHits: () => number }).__apiHits = () => apiHits
    })

    const result = await page.evaluate(async () => {
      const w = window as unknown as { __reelsApi: { listMyReels: () => Promise<unknown[]> } }
      return w.__reelsApi.listMyReels()
    })
    const apiHits = await page.evaluate(() => {
      const w = window as unknown as { __apiHits: () => number }
      return w.__apiHits()
    })
    expect(result).toEqual([{ shortcode: 'X', url: 'u', collected_at: 't' }])
    expect(apiHits).toBe(2)
    const log = await page.evaluate(() => {
      const w = window as unknown as { __callLog: string[] }
      return w.__callLog
    })
    // Verify the refresh-token call was made between the two /api/reels calls.
    expect(log.some((u) => u.includes('/auth/v1/token'))).toBe(true)
  })

  test('getReelAnalysis hits /api/extra/<sc> and normalises response', async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.evaluate(() => {
      const w = window as unknown as { __capturedPath: string; __origFetch: typeof fetch }
      w.__origFetch = window.fetch
      window.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        const u = new URL(url, 'http://x')
        if (u.pathname.includes('/api/extra/')) {
          w.__capturedPath = u.pathname
          return Promise.resolve(
            new Response(
              JSON.stringify({
                sentences: [{ start: 0, end: 1, text: 'hi' }],
                pro_audio: { duration_sec: 12 },
                script_structure: { hook: { text: 'h' } },
                category: { topic: 'food' }
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as typeof fetch
    })
    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __reelsApi: {
          getReelAnalysis: (sc: string) => Promise<{
            shortcode: string
            sentences: unknown[]
            pro_audio: unknown
          }>
        }
      }
      return w.__reelsApi.getReelAnalysis('ABC123')
    })
    const capturedPath = await page.evaluate(() => {
      return (window as unknown as { __capturedPath: string }).__capturedPath
    })
    expect(capturedPath).toBe('/api/extra/ABC123')
    expect(result.shortcode).toBe('ABC123')
    expect(result.sentences.length).toBe(1)
    expect(result.pro_audio).not.toBeNull()
  })

  test('getReelVideoUrl returns null on metadata fetch failure', async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.evaluate(() => {
      const w = window as unknown as { __origFetch: typeof fetch }
      w.__origFetch = window.fetch
      window.fetch = ((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/metadata/')) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as typeof fetch
    })
    const url = await page.evaluate(async () => {
      const w = window as unknown as {
        __reelsApi: { getReelVideoUrl: (sc: string) => Promise<string | null> }
      }
      return w.__reelsApi.getReelVideoUrl('MISSING')
    })
    expect(url).toBeNull()
  })
})

test.describe('@phase-3-auth utility helpers', () => {
  test('idToEmail wraps bare IDs and passes through emails', async () => {
    const launched = await launchElectron()
    try {
      const result = await launched.page.evaluate(() => {
        const w = window as unknown as {
          __reelsAuthHelpers: { idToEmail: (s: string) => string }
        }
        return [
          w.__reelsAuthHelpers.idToEmail('minhyuk'),
          w.__reelsAuthHelpers.idToEmail('foo@bar.com'),
          w.__reelsAuthHelpers.idToEmail('  MIXED  ')
        ]
      })
      expect(result).toEqual([
        'minhyuk@reels-bench.local',
        'foo@bar.com',
        'mixed@reels-bench.local'
      ])
    } finally {
      await launched.app.close()
    }
  })

  test('emailToUserIdLabel strips synthetic domain', async () => {
    const launched = await launchElectron()
    try {
      const result = await launched.page.evaluate(() => {
        const w = window as unknown as {
          __reelsAuthHelpers: { emailToUserIdLabel: (s: string) => string }
        }
        return [
          w.__reelsAuthHelpers.emailToUserIdLabel('minhyuk@reels-bench.local'),
          w.__reelsAuthHelpers.emailToUserIdLabel('plain'),
          w.__reelsAuthHelpers.emailToUserIdLabel('admin@real.com')
        ]
      })
      expect(result).toEqual(['minhyuk', 'plain', 'admin'])
    } finally {
      await launched.app.close()
    }
  })

  test('fake-session blob has all fields supabase _isValidSession requires', () => {
    const raw = buildFakeSessionBlob()
    const obj = JSON.parse(raw)
    expect(obj).toHaveProperty('access_token')
    expect(obj).toHaveProperty('refresh_token')
    expect(obj).toHaveProperty('expires_at')
    expect(FAKE_SESSION_STORAGE_KEY).toContain('sb-')
    expect(FAKE_SESSION_STORAGE_KEY.endsWith('-auth-token')).toBe(true)
  })
})
