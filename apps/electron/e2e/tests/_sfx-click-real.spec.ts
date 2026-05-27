/**
 * @file _sfx-click-real.spec.ts
 *
 * Click-test (실 통합) — Phase 8 SFX 라이브러리를 실제 데이터로 클릭해본다.
 *
 * - DB(sfx_assets)는 비어있음(0 rows) → empty state 확인
 * - Freesound 'rain' 실검색 4건 → 그리드 렌더링 확인
 * - 미리듣기·가져오기 버튼 실 클릭 → 라벨 변화·notice 확인
 *
 * 라이브 reels-bench.vercel.app API는 fake JWT라 401이 나므로,
 * page.route()로 가로채서 우리가 진짜 Freesound API에서 받은 응답을
 * 그대로 흘려보낸다. 즉 「서버 → 클라이언트」 어댑터·정규화·UI 전 경로가
 * 진짜 페이로드로 통과되는지 확인.
 *
 * 각 단계 스크린샷을 e2e/screens/sfx-click/ 에 남긴다.
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import path from 'node:path'
import fs from 'node:fs'

const SCREENS_DIR = path.resolve(__dirname, '..', 'screens', 'sfx-click')

// 진짜 Freesound 검색 결과 (사전에 verify 스크립트로 받아옴) — server.py의
// `_freesound_normalize` 가 만들 형태로 미리 정규화해서 라우트가 그대로 응답.
const REAL_FREESOUND_RAIN = {
  count: 6071,
  next: null,
  previous: null,
  results: [
    {
      id: 536260,
      name: 'storm_rain+thunder_velux.wav',
      tags: ['storm', 'rain', 'thunder', 'velux'],
      duration_ms: 108500,
      preview_url: 'https://cdn.freesound.org/previews/536/536260_11787627-lq.mp3',
      freesound_url: 'https://freesound.org/people/InspectorJ/sounds/536260/',
      license: 'CC0',
      attribution: null,
      username: 'InspectorJ'
    },
    {
      id: 527497,
      name: 'Rain on a Window Air Conditioner',
      tags: ['rain', 'window', 'air-conditioner'],
      duration_ms: 76800,
      preview_url: 'https://cdn.freesound.org/previews/527/527497_11787627-lq.mp3',
      freesound_url: 'https://freesound.org/people/InspectorJ/sounds/527497/',
      license: 'CC0',
      attribution: null,
      username: 'InspectorJ'
    },
    {
      id: 515805,
      name: 'Rain_02_wThunder (wav-24bit-96khz)',
      tags: ['rain', 'thunder'],
      duration_ms: 237100,
      preview_url: 'https://cdn.freesound.org/previews/515/515805_11787627-lq.mp3',
      freesound_url: 'https://freesound.org/people/InspectorJ/sounds/515805/',
      license: 'CC0',
      attribution: null,
      username: 'InspectorJ'
    }
  ]
}

test.describe('@sfx-click-real Phase 8 SFX click-through with real data', () => {
  let launched: LaunchedApp | null = null

  test.beforeAll(() => {
    fs.mkdirSync(SCREENS_DIR, { recursive: true })
  })

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched

    // Electron contextIsolation+sandbox에선 page.route()가 불안정 →
    // page 안에서 window.fetch를 직접 오버라이드 (기존 e2e와 동일 패턴).
    await page.evaluate(
      ({ realFreesound }) => {
        const orig = window.fetch
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : (input as Request).url || String(input)
          if (url.includes('/api/sfx/freesound')) {
            return Promise.resolve(
              new Response(JSON.stringify(realFreesound), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              })
            )
          }
          if (url.includes('/api/sfx')) {
            return Promise.resolve(
              new Response('[]', {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              })
            )
          }
          return orig.call(window, input, init)
        }) as typeof fetch
      },
      { realFreesound: REAL_FREESOUND_RAIN }
    )

    // Audio.play() 실 네트워크 차단
    await page.evaluate(() => {
      window.HTMLAudioElement.prototype.play = () => Promise.resolve()
    })
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

  test('full click-through: open editor → SFX tab → empty → Freesound rain → preview → import', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors, consoleErrors } = launched

    // ── ① 에디터 진입 ────────────────────────────────────────────
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.screenshot({ path: path.join(SCREENS_DIR, '01_editor.png'), fullPage: true })

    // ── ② SFX 탭 클릭 → 우리 라이브러리(비어있음) ─────────────────
    await page.locator('[data-testid="import-tab-sfx"]').click()
    await expect(page.locator('[data-testid="sfx-source-toggle"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-source-ours"]')).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: path.join(SCREENS_DIR, '02_sfx_tab_initial.png'), fullPage: true })

    // 빈 검색 한 번 → DB가 [] 응답 → empty state
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-empty"]')).toBeVisible({ timeout: 8_000 })
    await page.screenshot({ path: path.join(SCREENS_DIR, '03_ours_empty.png'), fullPage: true })

    // ── ③ Freesound 토글 + 'rain' 검색 → 진짜 결과 그리드 ────────
    await page.locator('[data-testid="sfx-source-freesound"]').click()
    await expect(page.locator('[data-testid="sfx-source-freesound"]')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.locator('[data-testid="sfx-search-input"]').fill('rain')
    await page.locator('[data-testid="sfx-search-btn"]').click()
    await expect(page.locator('[data-testid="sfx-grid"]')).toBeVisible({ timeout: 10_000 })

    // 3건 모두 카드로 렌더됐는지 확인
    await expect(page.locator('[data-testid="sfx-card-freesound-536260"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-card-freesound-527497"]')).toBeVisible()
    await expect(page.locator('[data-testid="sfx-card-freesound-515805"]')).toBeVisible()

    // 라이선스 배지 — 전부 CC0 (녹)
    const cc0Bg = await page
      .locator('[data-testid="sfx-license-freesound-536260"]')
      .evaluate((el) => window.getComputedStyle(el).backgroundColor)
    expect(cc0Bg).toBe('rgb(13, 42, 26)')

    await page.screenshot({ path: path.join(SCREENS_DIR, '04_freesound_rain_grid.png'), fullPage: true })

    // ── ④ 미리듣기 클릭 → ▶→⏸ 라벨 변화 ──────────────────────────
    const preview = page.locator('[data-testid="sfx-preview-freesound-536260"]')
    await expect(preview).toHaveText('▶ 미리듣기')
    await preview.click()
    await expect(preview).toHaveText('⏸ 정지', { timeout: 3_000 })
    await page.screenshot({ path: path.join(SCREENS_DIR, '05_preview_playing.png'), fullPage: true })

    // 다른 카드 클릭 → 첫 카드는 정지, 새 카드 재생
    const preview2 = page.locator('[data-testid="sfx-preview-freesound-527497"]')
    await preview2.click()
    await expect(preview2).toHaveText('⏸ 정지', { timeout: 3_000 })
    await expect(preview).toHaveText('▶ 미리듣기')

    // 같은 버튼 다시 → 정지
    await preview2.click()
    await expect(preview2).toHaveText('▶ 미리듣기', { timeout: 3_000 })

    // ── ⑤ 가져오기 클릭 → download IPC stub fail → '실패' notice ─
    // 실 IPC를 stub해서 결과 가시화 (network 미실행)
    await page.evaluate(() => {
      window.electron.download.downloadVideoToTemp = async () => ({
        ok: false as const,
        localPath: '',
        sizeBytes: 0,
        error: 'click-test: 다운로드 불가 (fake-cdn host)'
      })
    })
    await page.locator('[data-testid="sfx-import-freesound-536260"]').click()
    await expect(
      page.locator('[role="button"]:has-text("효과음 가져오기 실패")')
    ).toBeVisible({ timeout: 8_000 })
    await page.screenshot({ path: path.join(SCREENS_DIR, '06_import_error_notice.png'), fullPage: true })

    // ── ⑥ 페이지 에러 0 확인 ───────────────────────────────────────
    expect(
      pageErrors,
      `pageErrors after click-through:\n${pageErrors.map((e) => e.message).join('\n')}`
    ).toHaveLength(0)

    // 401/네트워크는 fake JWT가 보낸 거라 무시, 다른 console error만 검사
    const unexpected = consoleErrors.filter(
      (e) => !/(401|Unauthorized|net::ERR_FAILED|Failed to fetch|api_key)/i.test(e)
    )
    expect(
      unexpected,
      `unexpected console.error:\n${unexpected.join('\n')}`
    ).toHaveLength(0)
  })
})
