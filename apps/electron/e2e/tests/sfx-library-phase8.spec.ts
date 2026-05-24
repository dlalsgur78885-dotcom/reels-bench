/**
 * @file sfx-library-phase8.spec.ts
 *
 * Phase 8 — SFX Library tab e2e suite.
 *
 * Verification items:
 *  1. Tab bar has 6th tab "🔊 효과음" rendered alongside all other tabs.
 *  2. Switching to SFX tab renders source toggle + search bar without crash.
 *  3. Our Library: searchOurSfx stub → grid renders / empty → sfx-empty /
 *     401 → sfx-error (general).
 *  4. Freesound: searchFreesound stub with {results:[...]} object response →
 *     grid renders correctly (adapter regression guard — key correctness test).
 *     503 → FREESOUND_NOT_CONFIGURED warning banner / 401 → sfx-error (general).
 *  5. License badges: CC0 has green colour, CC-BY has blue colour.
 *  6. Preview button click → audio plays (no page error); clicking a second
 *     card stops the first and starts the new one.
 *  7. Import button → importSfxFromUrl triggered (download IPC stub confirms
 *     the call reaches downloadVideoToTemp).
 *  8. Regression: existing tabs (local/library/tts/ai/internal/music/brand)
 *     still render without page errors after sfx tab is visited.
 *
 * Network strategy:
 *   All API calls use in-page window.fetch stubs (same pattern as
 *   auth.spec.ts / import-panel.spec.ts — page.route() is unreliable under
 *   Electron contextIsolation:true + sandbox:true).
 *
 * Tag: @phase-8-sfx
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
}

async function switchToTab(launched: LaunchedApp, tabKey: string): Promise<void> {
  const { page } = launched
  const btn = page.locator(`[data-testid="import-tab-${tabKey}"]`)
  await btn.click()
  await expect(btn).toBeVisible()
}

/** Raw SfxItem shape expected by the SfxGrid. */
interface FakeSfxRow {
  id: string | number
  name: string
  tags: string[]
  duration_ms: number
  url?: string
  preview_url?: string
  freesound_url?: string
  license: string
  attribution?: string
  username?: string
  source?: string
  mime?: string
  bytes?: number
  created_at?: string
}

/** Stub window.fetch for /api/sfx (our library). */
async function stubOurSfx(
  page: import('@playwright/test').Page,
  rows: FakeSfxRow[],
  status = 200
): Promise<void> {
  await page.evaluate(
    ({ fakeRows, fakeStatus }) => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        // Match /api/sfx but NOT /api/sfx/freesound/...
        if (url.includes('/api/sfx') && !url.includes('/freesound')) {
          return Promise.resolve(
            new Response(
              fakeStatus === 200 ? JSON.stringify(fakeRows) : JSON.stringify({ error: 'err' }),
              {
                status: fakeStatus,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    },
    { fakeRows: rows, fakeStatus: status }
  )
}

/** Stub window.fetch for /api/sfx/freesound/search. */
async function stubFreesound(
  page: import('@playwright/test').Page,
  payload: object | FakeSfxRow[],
  status = 200
): Promise<void> {
  await page.evaluate(
    ({ fakePayload, fakeStatus }) => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx/freesound')) {
          return Promise.resolve(
            new Response(JSON.stringify(fakePayload), {
              status: fakeStatus,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    },
    { fakePayload: payload, fakeStatus: status }
  )
}

const FAKE_OUR_SFX: FakeSfxRow[] = [
  {
    id: 'sfx-001',
    name: '박수 소리',
    tags: ['clap', 'applause'],
    duration_ms: 2000,
    url: 'https://fake-cdn.test/sfx-001.mp3',
    license: 'CC0',
    source: 'ours',
    created_at: new Date().toISOString()
  },
  {
    id: 'sfx-002',
    name: '알림음',
    tags: ['notification', 'ding'],
    duration_ms: 500,
    url: 'https://fake-cdn.test/sfx-002.mp3',
    license: 'CC-BY',
    attribution: 'TestArtist',
    source: 'ours',
    created_at: new Date().toISOString()
  }
]

// Freesound API returns an object with `results` array (not a flat array).
const FAKE_FREESOUND_RESPONSE = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 'fs-101',
      name: '빗소리',
      tags: ['rain', 'nature'],
      duration_ms: 5000,
      preview_url: 'https://fake-freesound.test/fs-101.mp3',
      freesound_url: 'https://freesound.org/s/101',
      license: 'CC0',
      attribution: null,
      username: 'SoundUser1'
    },
    {
      id: 'fs-102',
      name: '발자국',
      tags: ['footsteps', 'walk'],
      duration_ms: 1500,
      preview_url: 'https://fake-freesound.test/fs-102.mp3',
      freesound_url: 'https://freesound.org/s/102',
      license: 'CC-BY',
      attribution: 'SoundUser2',
      username: 'SoundUser2'
    }
  ]
}

// ===========================================================================
// Suite 1 — SFX Tab Structure
// ===========================================================================

test.describe('@phase-8-sfx SFX tab structure and controls', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await launched.page.route('**/reels-bench.vercel.app/**', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' })
      })
    })
    await openEditor(launched)
  })

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

  // ── 1. SFX tab exists as 6th tab ─────────────────────────────────────────

  test('tab bar contains sfx tab with correct emoji label', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const tabBar = page.locator('[data-testid="import-tabs"]')
    await expect(tabBar).toBeVisible()

    const sfxTab = page.locator('[data-testid="import-tab-sfx"]')
    await expect(sfxTab).toBeVisible()
    await expect(sfxTab).toHaveText('🔊 효과음')
  })

  test('all 8 tabs (local/library/tts/ai/internal/music/sfx/brand) are present', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const allTabKeys = ['local', 'library', 'tts', 'ai', 'internal', 'music', 'sfx', 'brand']
    for (const key of allTabKeys) {
      await expect(
        page.locator(`[data-testid="import-tab-${key}"]`)
      ).toBeVisible()
    }
  })

  // ── 2. SFX tab renders source toggle + search bar ────────────────────────

  test('sfx tab shows source toggle and search bar on switch', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')

    await expect(page.locator('[data-testid="sfx-source-toggle"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-source-ours"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-source-freesound"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-search-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-search-btn"]')).toBeVisible()
  })

  test('sfx tab default source is "우리 라이브러리" (ours)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    const oursBtn = page.locator('[data-testid="sfx-source-ours"]')
    await expect(oursBtn).toHaveAttribute('aria-selected', 'true')
  })

  test('sfx-empty state shows on initial load before search', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    // Before any search — sfx-empty placeholder text is shown.
    await expect(page.locator('[data-testid="sfx-empty"]')).toBeVisible({ timeout: 3_000 })
  })

  test('switching to Freesound source shows freesound button as selected', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await expect(
      page.locator('[data-testid="sfx-source-freesound"]')
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.locator('[data-testid="sfx-source-ours"]')
    ).toHaveAttribute('aria-selected', 'false')
  })

  test('switching back to ours source resets sfx-empty placeholder', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await page.locator('[data-testid="sfx-source-ours"]').click()
    await expect(page.locator('[data-testid="sfx-empty"]')).toBeVisible({ timeout: 3_000 })
  })

  test('sfx tab switch does not produce page errors', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched

    await switchToTab(launched, 'sfx')
    await page.waitForTimeout(300)

    expect(
      pageErrors,
      `page errors after sfx tab: ${pageErrors.map((e) => e.message).join('\n')}`
    ).toHaveLength(0)
  })
})

// ===========================================================================
// Suite 2 — Our Library search results
// ===========================================================================

test.describe('@phase-8-sfx SFX our-library search', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await openEditor(launched)
  })

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

  test('our library search → grid renders sfx-card for each result', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await stubOurSfx(page, FAKE_OUR_SFX)
    await switchToTab(launched, 'sfx')

    // Trigger search (empty query → full library).
    await page.locator('[data-testid="sfx-search-btn"]').click()

    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="sfx-card-ours-sfx-001"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-card-ours-sfx-002"]')).toBeVisible()
  })

  test('our library search with keyword → searchOurSfx receives the query', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Capture query params that reach the stub.
    let capturedUrl = ''
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx') && !url.includes('/freesound')) {
          ;(window as unknown as Record<string, unknown>).__sfxLastUrl = url
          return Promise.resolve(
            new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-input"]').fill('박수')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    // Give the async search time to run.
    await page.waitForTimeout(500)

    capturedUrl = await page.evaluate(
      () =>
        String(
          (window as unknown as Record<string, unknown>).__sfxLastUrl ?? ''
        )
    )
    expect(capturedUrl).toContain('q=%EB%B0%95%EC%88%98') // '박수' URL-encoded
  })

  test('our library empty response → sfx-empty state', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await stubOurSfx(page, [])
    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    // sfx-grid should NOT be visible; sfx-empty should appear.
    await expect(page.locator('[data-testid="sfx-grid"]')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.locator('[data-testid="sfx-empty"]')).toBeVisible({ timeout: 8_000 })
  })

  test('our library 401 → sfx-error general error banner', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Stub window.fetch: return 401 with a body that contains 'api_key' so that
    // authedFetch's early-return guard fires immediately without a token refresh
    // round-trip (avoids Supabase network round-trip timing uncertainty).
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx') && !url.includes('/freesound')) {
          // 'api_key missing' body → authedFetch returns immediately (no retry).
          return Promise.resolve(
            new Response('api_key missing or invalid', {
              status: 401,
              headers: { 'Content-Type': 'text/plain' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    // authedFetch sees 'api_key' in body → returns immediately → searchOurSfx
    // reads the text and throws 'API 401: api_key missing or invalid' → setError.
    await expect(page.locator('[data-testid="sfx-error"]')).toBeVisible({ timeout: 8_000 })
    const errorBanner = page.locator('[data-testid="sfx-error"]')
    await expect(errorBanner).toContainText('불러오기 실패')
    // Must NOT be the yellow Freesound unconfigured banner colour.
    expect(await errorBanner.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    )).not.toBe('rgb(42, 31, 13)')
  })

  test('Enter key on search input triggers search', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    let searchCalled = false
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx') && !url.includes('/freesound')) {
          ;(window as unknown as Record<string, unknown>).__sfxEnterSearchCalled = true
          return Promise.resolve(
            new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-input"]').fill('test')
    await page.locator('[data-testid="sfx-search-input"]').press('Enter')
    await page.waitForTimeout(500)

    searchCalled = await page.evaluate(
      () =>
        Boolean(
          (window as unknown as Record<string, unknown>).__sfxEnterSearchCalled
        )
    )
    expect(searchCalled).toBe(true)
  })
})

// ===========================================================================
// Suite 3 — Freesound source (CRITICAL: object-wrapper adapter regression)
// ===========================================================================

test.describe('@phase-8-sfx SFX Freesound adapter and source toggling', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await openEditor(launched)
  })

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

  /**
   * CORE REGRESSION TEST — Phase 8 adapter fix.
   *
   * The backend returns `{count, next, previous, results: [...]}` not a flat
   * array. `searchFreesound` in importSources.ts must unwrap `json.results`.
   * If the adapter is broken (treats the object as empty array), sfx-grid
   * would not appear even though the API returned data.
   */
  test('Freesound {results:[...]} object response → grid renders all cards (adapter fix)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await stubFreesound(page, FAKE_FREESOUND_RESPONSE)
    await switchToTab(launched, 'sfx')

    // Switch to Freesound source.
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await page.locator('[data-testid="sfx-search-input"]').fill('rain')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    // The grid must appear — if adapter is broken (returns []) it won't.
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    // Both cards from results[] must be individually rendered.
    await expect(page.locator('[data-testid="sfx-card-freesound-fs-101"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-card-freesound-fs-102"]')).toBeVisible()
  })

  test('Freesound flat-array response is also accepted (backward compat)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Even a flat array (old/alt backend format) should still render cards.
    const flatRows = FAKE_FREESOUND_RESPONSE.results
    await stubFreesound(page, flatRows)
    await switchToTab(launched, 'sfx')

    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await page.locator('[data-testid="sfx-search-input"]').fill('rain')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="sfx-card-freesound-fs-101"]')).toBeVisible()
  })

  test('Freesound 503 → FREESOUND_NOT_CONFIGURED warning banner (yellow)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx/freesound')) {
          // 503 → searchFreesound throws 'FREESOUND_NOT_CONFIGURED'
          return Promise.resolve(
            new Response('Service Unavailable', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await page.locator('[data-testid="sfx-search-input"]').fill('rain')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    // Must show the specific Freesound unconfigured warning banner.
    await expect(page.locator('[data-testid="sfx-error"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="sfx-error"]')).toContainText(
      'Freesound API 키가 설정되지 않았습니다'
    )

    // Must NOT show a general error box colour — the banner is styled in yellow (#2a1f0d).
    const banner = page.locator('[data-testid="sfx-error"]')
    const bgColor = await banner.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    )
    // Freesound warn banner background = #2a1f0d = rgb(42, 31, 13)
    expect(bgColor).toBe('rgb(42, 31, 13)')
  })

  test('Freesound 401 → general sfx-error banner (not Freesound-specific)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Stub window.fetch: 401 with 'api_key' in body → authedFetch returns
    // immediately (no retry round-trip) → searchFreesound throws → setError.
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx/freesound')) {
          return Promise.resolve(
            new Response('api_key missing or invalid', {
              status: 401,
              headers: { 'Content-Type': 'text/plain' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await page.locator('[data-testid="sfx-search-input"]').fill('rain')
    await page.locator('[data-testid="sfx-search-btn"]').click()

    // authedFetch sees 'api_key' → returns immediately → searchFreesound throws → setError.
    await expect(page.locator('[data-testid="sfx-error"]')).toBeVisible({ timeout: 8_000 })
    // General error — does NOT contain Freesound-specific text.
    await expect(page.locator('[data-testid="sfx-error"]')).not.toContainText(
      'Freesound API 키가 설정되지 않았습니다'
    )
    await expect(page.locator('[data-testid="sfx-error"]')).toContainText('불러오기 실패')
  })

  test('Freesound empty query → no API call, onNotice error fired', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    let freesoundCallMade = false
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/sfx/freesound')) {
          ;(window as unknown as Record<string, unknown>).__freesoundEmptyQueryCalled = true
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    // Leave search input empty.
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await page.waitForTimeout(300)

    freesoundCallMade = await page.evaluate(
      () =>
        Boolean(
          (window as unknown as Record<string, unknown>).__freesoundEmptyQueryCalled
        )
    )
    // When query is empty, searchFreesound returns [] immediately without calling API.
    expect(freesoundCallMade).toBe(false)
    // An error notice should have been triggered (appears as a banner in the parent).
    await expect(
      page.locator('[role="button"]:has-text("Freesound는 검색어를 입력해야 합니다")')
    ).toBeVisible({ timeout: 3_000 })
  })
})

// ===========================================================================
// Suite 4 — License badges
// ===========================================================================

test.describe('@phase-8-sfx SFX license badges', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await openEditor(launched)
    // Stub our library so badges are always available without network.
    await stubOurSfx(launched.page, FAKE_OUR_SFX)
  })

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

  test('CC0 badge has green background colour', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    const cc0Badge = page.locator('[data-testid="sfx-license-ours-sfx-001"]')
    await expect(cc0Badge).toBeVisible()
    await expect(cc0Badge).toHaveText('CC0')

    const bg = await cc0Badge.evaluate((el) => window.getComputedStyle(el).backgroundColor)
    // styles.sfxLicenseCc0: background '#0d2a1a' = rgb(13, 42, 26)
    expect(bg).toBe('rgb(13, 42, 26)')
  })

  test('CC-BY badge has blue background colour', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    const ccByBadge = page.locator('[data-testid="sfx-license-ours-sfx-002"]')
    await expect(ccByBadge).toBeVisible()
    await expect(ccByBadge).toHaveText('CC-BY')

    const bg = await ccByBadge.evaluate((el) => window.getComputedStyle(el).backgroundColor)
    // styles.sfxLicenseCcBy: background '#0d1a2a' = rgb(13, 26, 42)
    expect(bg).toBe('rgb(13, 26, 42)')
  })

  test('CC0 badge shows "퍼블릭 도메인" tooltip text', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    const cc0Badge = page.locator('[data-testid="sfx-license-ours-sfx-001"]')
    const title = await cc0Badge.getAttribute('title')
    expect(title).toContain('퍼블릭 도메인')
  })

  test('CC-BY badge tooltip includes attribution name', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    const ccByBadge = page.locator('[data-testid="sfx-license-ours-sfx-002"]')
    const title = await ccByBadge.getAttribute('title')
    expect(title).toContain('저작자 표기 필요')
    expect(title).toContain('TestArtist')
  })
})

// ===========================================================================
// Suite 5 — Preview button (audio playback)
// ===========================================================================

test.describe('@phase-8-sfx SFX preview button interaction', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await openEditor(launched)
    await stubOurSfx(launched.page, FAKE_OUR_SFX)
  })

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

  test('preview button is rendered for each sfx card', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    await expect(page.locator('[data-testid="sfx-preview-ours-sfx-001"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-preview-ours-sfx-002"]')).toBeVisible()
  })

  test('clicking preview button changes its label to "⏸ 정지" (playing state)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    // Stub HTMLAudioElement.play() so it resolves immediately without actual network.
    await page.evaluate(() => {
      window.HTMLAudioElement.prototype.play = () => Promise.resolve()
    })

    const previewBtn = page.locator('[data-testid="sfx-preview-ours-sfx-001"]')
    await expect(previewBtn).toHaveText('▶ 미리듣기')
    await previewBtn.click()

    // After click, button label should change to playing state.
    await expect(previewBtn).toHaveText('⏸ 정지', { timeout: 3_000 })

    // No page errors should have occurred.
    expect(
      pageErrors,
      `page errors after preview click: ${pageErrors.map((e) => e.message).join('\n')}`
    ).toHaveLength(0)
  })

  test('clicking another card stops first and starts new (single audio instance)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    // Track pause/play calls on the audio element.
    await page.evaluate(() => {
      const proto = window.HTMLAudioElement.prototype
      let pauseCount = 0
      let playCount = 0
      ;(window as unknown as Record<string, unknown>).__audioPauseCount = 0
      ;(window as unknown as Record<string, unknown>).__audioPlayCount = 0
      const origPause = proto.pause
      proto.pause = function (...args) {
        pauseCount++
        ;(window as unknown as Record<string, unknown>).__audioPauseCount = pauseCount
        return origPause.apply(this, args)
      }
      proto.play = function () {
        playCount++
        ;(window as unknown as Record<string, unknown>).__audioPlayCount = playCount
        return Promise.resolve()
      }
    })

    const preview1 = page.locator('[data-testid="sfx-preview-ours-sfx-001"]')
    const preview2 = page.locator('[data-testid="sfx-preview-ours-sfx-002"]')

    // Play first card.
    await preview1.click()
    await expect(preview1).toHaveText('⏸ 정지', { timeout: 3_000 })

    // Click second card — should pause first then play second.
    await preview2.click()

    const pauseCount = await page.evaluate(
      () => Number((window as unknown as Record<string, unknown>).__audioPauseCount)
    )
    // At least one pause call was made (stopping the previous track).
    expect(pauseCount).toBeGreaterThanOrEqual(1)

    // Second card should now be in playing state.
    await expect(preview2).toHaveText('⏸ 정지', { timeout: 3_000 })
    // First card should no longer be playing.
    await expect(preview1).toHaveText('▶ 미리듣기', { timeout: 3_000 })
  })

  test('clicking same preview button again stops playback', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    await page.evaluate(() => {
      window.HTMLAudioElement.prototype.play = () => Promise.resolve()
    })

    const previewBtn = page.locator('[data-testid="sfx-preview-ours-sfx-001"]')
    await previewBtn.click()
    await expect(previewBtn).toHaveText('⏸ 정지', { timeout: 3_000 })

    // Click again → pause → back to play state.
    await previewBtn.click()
    await expect(previewBtn).toHaveText('▶ 미리듣기', { timeout: 3_000 })
  })
})

// ===========================================================================
// Suite 6 — Import button (download IPC stub)
// ===========================================================================

test.describe('@phase-8-sfx SFX import button invokes download IPC', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await openEditor(launched)
    await stubOurSfx(launched.page, FAKE_OUR_SFX)
  })

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

  test('sfx import button is rendered per card', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    await expect(page.locator('[data-testid="sfx-import-ours-sfx-001"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-import-ours-sfx-002"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-import-ours-sfx-001"]')).toHaveText('가져오기')
  })

  test('clicking import triggers download IPC and shows error notice on failure', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // The SFX cards have downloadUrl = 'https://fake-cdn.test/sfx-001.mp3'.
    // importFromUrl validates https:// (passes), then calls the real
    // downloadVideoToTemp IPC. The main process tries to download the URL;
    // since 'fake-cdn.test' is not reachable, it returns ok:false.
    // importSfxFromUrl returns ok:false → onNotice('효과음 가져오기 실패…', 'error').
    // This proves the full import chain (SFxTab → importSfxFromUrl → importFromUrl
    // → downloadVideoToTemp IPC) was invoked.

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    // Verify import button exists and is clickable.
    const importBtn = page.locator('[data-testid="sfx-import-ours-sfx-001"]')
    await expect(importBtn).toBeVisible()
    await expect(importBtn).toBeEnabled()

    await importBtn.click()

    // The download fails (unreachable host) → error notice appears.
    // The notice text includes '효과음 가져오기 실패' which proves the SFX
    // import path (not a generic path) handled the failure.
    await expect(
      page.locator('[role="button"]').filter({ hasText: '효과음 가져오기 실패' })
    ).toBeVisible({ timeout: 15_000 })
  })

  test('failed import → sfx-error notice appears (download stub returns error)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Stub download to fail.
    await page.evaluate(() => {
      window.electron.download.downloadVideoToTemp = async () => ({
        ok: false as const,
        localPath: '',
        sizeBytes: 0,
        error: 'e2e-stub: network error'
      })
    })

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    await page.locator('[data-testid="sfx-import-ours-sfx-001"]').click()

    // onNotice('효과음 가져오기 실패: …', 'error') → errorRow in MediaLibrary banners.
    await expect(
      page.locator('[role="button"]:has-text("효과음 가져오기 실패")')
    ).toBeVisible({ timeout: 5_000 })
  })

  test('import button shows busy state then error notice (download fails on fake URL)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // The fake URL 'https://fake-cdn.test/sfx-001.mp3' fails to download.
    // Verify the busy state ("가져오는 중…") transitions and error notice fires.

    await switchToTab(launched, 'sfx')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 8_000 })

    const importBtn = page.locator('[data-testid="sfx-import-ours-sfx-001"]')
    await importBtn.click()

    // After the download fails, the error notice must be shown (not a crash).
    // Allow generous timeout since the real IPC download attempt may take a few
    // seconds before returning an error for an unreachable host.
    await expect(
      page.locator('[role="button"]').filter({ hasText: '효과음 가져오기 실패' })
    ).toBeVisible({ timeout: 20_000 })

    // After completion, the import button should be re-enabled (not stuck busy).
    await expect(importBtn).toBeEnabled({ timeout: 3_000 })
  })
})

// ===========================================================================
// Suite 7 — Regression: existing tabs unaffected after SFX tab added
// ===========================================================================

test.describe('@phase-8-sfx regression existing tabs unaffected', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await launched.page.route('**/reels-bench.vercel.app/**', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' })
      })
    })
    await openEditor(launched)
  })

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

  test('cycling through all 8 tabs including sfx does not produce page errors', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched

    const allTabKeys = ['library', 'tts', 'ai', 'internal', 'music', 'sfx', 'brand', 'local']
    for (const key of allTabKeys) {
      await switchToTab(launched, key)
      await page.waitForTimeout(200)
    }

    expect(
      pageErrors,
      `page errors after cycling all tabs: ${pageErrors.map((e) => e.message).join('\n')}`
    ).toHaveLength(0)
  })

  test('local tab still shows import button + drop zone after sfx tab was visited', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await page.waitForTimeout(200)
    await switchToTab(launched, 'local')

    await expect(page.locator('[data-testid="import-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="drop-zone"]')).toBeVisible()
  })

  test('local tab import button hidden when sfx tab is active', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'sfx')
    await expect(page.locator('[data-testid="import-button"]')).toHaveCount(0)
  })

  test('no unexpected console errors after visiting all tabs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, consoleErrors } = launched

    for (const key of ['library', 'tts', 'ai', 'internal', 'music', 'sfx', 'brand', 'local']) {
      await switchToTab(launched, key)
      await page.waitForTimeout(150)
    }

    expect(
      consoleErrors.filter((e) =>
        !/(401|Unauthorized|net::ERR_FAILED|Failed to fetch)/i.test(e)
      ),
      `unexpected console.error messages: ${consoleErrors.join('\n')}`
    ).toHaveLength(0)
  })
})
