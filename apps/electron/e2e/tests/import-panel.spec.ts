/**
 * @file import-panel.spec.ts
 *
 * Phase 1 — MediaLibrary "소스별 4버튼" import-panel E2E tests.
 *
 * Covers:
 *   1. Regression: local-tab (① 내 PC) still shows import button + drop zone
 *   2. Tab bar renders all 5 tabs with correct labels
 *   3. Switching to each remote tab does not crash the renderer
 *   4. Remote tabs (②③④⑤) in no-network / no-auth context show error or
 *      empty-state banners rather than a blank / broken view
 *   5. TTS tab renders the script picker list (대본 picker) — not a job-ID input
 *   6. AI tab renders prompt textarea + local image pick button (not URL input) + submit button
 *   7. The local tab's import button is only visible on the local tab
 *   8. IPC contract regression: app launches and download bridge is still exposed
 *
 * Network strategy:
 *   All calls to the reels-bench API are intercepted by Playwright route
 *   interception in the renderer.  Two scenarios are exercised:
 *     a) 401 / auth error  → panels must show an error banner, not crash
 *     b) 200 empty array   → panels must show empty-state text, not crash
 *
 * Phase 1 보강 (ImportPanel.tsx) 변경 사항:
 *   - ③ TTS & SRT: job-ID 직접 입력 → 대본 picker (script-picker-list + script-row-*)
 *   - ④ AI 영상 생성: image URL 입력 → 로컬 파일 업로드 (ai-image-file hidden input + ai-image-pick-btn)
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the editor view so the MediaLibrary is mounted. */
async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
}

/** Click a tab button by its data-testid and wait for it to become active. */
async function switchToTab(
  launched: LaunchedApp,
  tabKey: string
): Promise<void> {
  const { page } = launched
  const btn = page.locator(`[data-testid="import-tab-${tabKey}"]`)
  await btn.click()
  // Active tab gets green background colour; assert aria or style isn't strictly
  // needed — just verify the click didn't throw (no page error).
  await expect(btn).toBeVisible()
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('@phase-1-import-panel MediaLibrary 5-tab import panel', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    // Intercept all reels-bench API calls so tests are fully offline.
    // Default: return 401 so remote tabs surface auth/error states.
    // Note: Playwright matches routes in LIFO order — last registered wins.
    // We register the catch-all LAST so tests can override specific paths
    // by registering their own routes AFTER this beforeEach completes.
    await launched.page.route(
      '**/reels-bench.vercel.app/**',
      async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' })
        })
      }
    )
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

  // ── 1. Tab bar renders all 5 tabs ────────────────────────────────────────

  test('tab bar is visible and contains all 5 source tabs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const tabBar = page.locator('[data-testid="import-tabs"]')
    await expect(tabBar).toBeVisible()

    // All five tab buttons must be present.
    const tabKeys = ['local', 'library', 'tts', 'ai', 'internal']
    for (const key of tabKeys) {
      await expect(
        page.locator(`[data-testid="import-tab-${key}"]`)
      ).toBeVisible()
    }
  })

  test('tab buttons carry the expected Korean labels', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const expectedLabels: Record<string, string> = {
      local: '① 내 PC',
      library: '② 영상 라이브러리',
      tts: '③ TTS & SRT',
      ai: '④ AI 영상 생성',
      internal: '내부 영상'
    }

    for (const [key, label] of Object.entries(expectedLabels)) {
      const btn = page.locator(`[data-testid="import-tab-${key}"]`)
      await expect(btn).toHaveText(label)
    }
  })

  // ── 2. Regression: local tab still works ────────────────────────────────

  test('local tab is the default active tab and shows import button + drop zone', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // The import button is only shown when the local tab is active.
    await expect(page.locator('[data-testid="import-button"]')).toBeVisible()
    // Drop zone is visible on the local tab.
    await expect(page.locator('[data-testid="drop-zone"]')).toBeVisible()
  })

  test('local tab drop zone has placeholder text', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const dropZone = page.locator('[data-testid="drop-zone"]')
    await expect(dropZone).toContainText('가져오기')
  })

  test('local media can be filtered by folder and sorted from the empty-space context menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => {
              createNew: () => void
              addMedia: (asset: unknown) => void
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      const state = store.getState()
      state.createNew()
      const base = {
        kind: 'video',
        width: 1080,
        height: 1920,
        codec: 'h264',
        fileSizeBytes: 0
      }
      state.addMedia({
        ...base,
        id: 'media-zeta',
        path: 'C:\\source\\folder-a\\zeta.mp4',
        durationMs: 3000,
        importedAt: 300,
        fileName: 'zeta.mp4'
      })
      state.addMedia({
        ...base,
        id: 'media-alpha',
        path: 'C:\\source\\folder-a\\alpha.mp4',
        durationMs: 1000,
        importedAt: 100,
        fileName: 'alpha.mp4'
      })
      state.addMedia({
        ...base,
        id: 'media-bravo',
        path: 'D:\\assets\\folder-b\\bravo.mp4',
        durationMs: 2000,
        importedAt: 200,
        fileName: 'bravo.mp4'
      })
    })

    await expect(page.locator('[data-testid="media-card"]')).toHaveCount(3)
    await expect(page.locator('[data-testid="media-library-controls"]')).toBeVisible()

    await page.locator('[data-testid="drop-zone"]').click({ button: 'right' })
    await expect(page.locator('[data-testid="media-library-context-menu"]')).toBeVisible()
    await page.locator('[data-testid="media-context-folder"]').filter({ hasText: 'folder-b' }).click()
    await expect(page.locator('[data-testid="media-card"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="media-card-name"]')).toHaveText('bravo.mp4')

    await page.locator('[data-testid="media-folder-filter"]').selectOption('__all__')
    await page.locator('[data-testid="media-sort-select"]').selectOption('nameAsc')
    await expect(page.locator('[data-testid="media-card-name"]')).toHaveText([
      'alpha.mp4',
      'bravo.mp4',
      'zeta.mp4'
    ])
  })

  test('local media can create a user folder from the empty-space context menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'local')
    await page.locator('[data-testid="drop-zone"]').click({ button: 'right' })
    await page.locator('[data-testid="media-context-folder-new"]').click()
    await page.locator('[data-testid="media-context-folder-new-input"]').fill('캠페인 A')
    await page.locator('[data-testid="media-context-folder-new-ok"]').click()

    await expect(page.locator('[data-testid="media-folder-filter"]')).toHaveValue('user:캠페인 A')
    await expect(page.locator('[data-testid="drop-zone"]')).toContainText('"캠페인 A" 폴더로 가져오기')
  })

  test('slide 5: imported media can be dragged into a visible default folder', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => {
              createNew: () => void
              addMedia: (asset: unknown) => void
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      const state = store.getState()
      state.createNew()
      const base = {
        kind: 'video',
        width: 1080,
        height: 1920,
        codec: 'h264',
        fileSizeBytes: 0
      }
      state.addMedia({
        ...base,
        id: 'media-alpha',
        path: 'C:\\source\\imports\\alpha.mp4',
        durationMs: 1000,
        importedAt: 100,
        fileName: 'alpha.mp4'
      })
      state.addMedia({
        ...base,
        id: 'media-bravo',
        path: 'C:\\source\\imports\\bravo.mp4',
        durationMs: 2000,
        importedAt: 200,
        fileName: 'bravo.mp4'
      })
    })

    await expect(page.locator('[data-testid="media-card"]')).toHaveCount(2)

    await expect(page.locator('[data-testid="media-folder-drop-tray"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="media-folder-drop-target"]').filter({ hasText: '영상' })
    ).toBeVisible()

    await page.evaluate(() => {
      const card = document.querySelector(
        '[data-testid="media-card"][data-media-id="media-alpha"]'
      ) as HTMLElement | null
      const target = Array.from(
        document.querySelectorAll('[data-testid="media-folder-drop-target"]')
      ).find(
        (el) => (el as HTMLElement).dataset.folderName === '영상'
      ) as HTMLElement | undefined
      if (!card || !target) throw new Error('drag source or folder target missing')

      const dt = new DataTransfer()
      dt.setData('application/x-reels-media-id', 'media-alpha')
      dt.setData('text/plain', 'media-alpha')
      card.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        })
      )
      target.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        })
      )
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        })
      )
      card.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt
        })
      )
    })

    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __PROJECT_STORE_FOR_TEST__: {
              getState: () => {
                project: { media: Record<string, { libraryFolder?: string }> }
              }
            }
          }
        ).__PROJECT_STORE_FOR_TEST__.getState().project.media['media-alpha']
          ?.libraryFolder === '영상',
      null,
      { timeout: 3_000 }
    )

    await page.locator('[data-testid="media-folder-filter"]').selectOption('user:영상')
    await expect(page.locator('[data-testid="media-card"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="media-card-name"]')).toHaveText('alpha.mp4')
  })

  test('switching away from local tab hides the import button', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'tts')
    // The local-only import button must be hidden on non-local tabs.
    await expect(page.locator('[data-testid="import-button"]')).toHaveCount(0)
  })

  test('switching back to local tab restores import button and drop zone', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'library')
    await expect(page.locator('[data-testid="import-button"]')).toHaveCount(0)

    await switchToTab(launched, 'local')
    await expect(page.locator('[data-testid="import-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="drop-zone"]')).toBeVisible()
  })

  // ── 3. Switching tabs never crashes the renderer ─────────────────────────

  test('cycling through all 5 tabs does not produce page errors', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, pageErrors } = launched

    const tabKeys = ['library', 'tts', 'ai', 'internal', 'local']
    for (const key of tabKeys) {
      await switchToTab(launched, key)
      // Give the tab panel a moment to mount and settle.
      await page.waitForTimeout(200)
    }

    expect(
      pageErrors,
      `page errors after tab cycling: ${pageErrors.map((e) => e.message).join('\n')}`
    ).toHaveLength(0)
  })

  // ── 4. Remote tabs with 401 → error or empty-state banners ───────────────

  test('library tab (②) shows error or empty-state banner on 401', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'library')
    // Wait up to 8s for the async fetch to settle.
    await page.waitForTimeout(500)
    // The component renders either a loading state, an error box, an
    // empty-state message, or a retry button — none of these are a crash.
    // Assert that *something* meaningful is rendered (no blank/empty DOM).
    const panel = page.locator('[data-testid="editor-page"]')
    await expect(panel).toBeVisible()
    // Error-box or retry button or state text — any one suffices.
    const anyFeedback = page.locator(
      'button:has-text("다시 시도"), [data-testid="remote-grid"], div:has-text("불러오기 실패"), div:has-text("저장된 영상이 없습니다")'
    )
    await expect(anyFeedback.first()).toBeVisible({ timeout: 8_000 })
  })

  test('internal tab (⑤) shows error or empty-state banner on 401', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'internal')
    await page.waitForTimeout(500)
    const panel = page.locator('[data-testid="editor-page"]')
    await expect(panel).toBeVisible()
    const anyFeedback = page.locator(
      'button:has-text("다시 시도"), [data-testid="remote-grid"], div:has-text("불러오기 실패"), div:has-text("저장된 릴스가 없습니다")'
    )
    await expect(anyFeedback.first()).toBeVisible({ timeout: 8_000 })
  })

  // ── 5. Library tab with empty 200 ────────────────────────────────────────

  test('library tab shows empty-state message when API returns empty array', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // page.route() doesn't reliably intercept fetch() in Electron renderer
    // running under sandbox:true + contextIsolation:true (same constraint as
    // auth.spec.ts). Stub window.fetch directly in-page instead.
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/seedance/videos')) {
          return Promise.resolve(
            new Response('[]', {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'library')
    // Wait for loading spinner to disappear and empty state to appear.
    // Use getByText for exact match to avoid strict-mode violations from
    // ancestor div nodes also containing this substring.
    await expect(
      page.getByText('저장된 영상이 없습니다.')
    ).toBeVisible({ timeout: 8_000 })
  })

  // ── 6. TTS tab UI (대본 picker — Phase 1 보강 후) ────────────────────────
  //
  // 변경: job-ID 텍스트 입력 + 가져오기 버튼 → 대본 picker 목록으로 교체.
  // 401 응답 환경에서는 fetchMyScripts() 실패 → 에러박스 또는 빈 상태 표시.
  // 대본이 없으면 "저장된 대본이 없습니다." 빈 상태 메시지가 표시된다.
  // 과거 tts-job-input / tts-import-btn testid는 존재하지 않는다.

  test('TTS tab shows script picker list or error/empty-state (no job-ID input)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'tts')
    // Old job-ID input must NOT be present — it was replaced by the picker.
    await expect(page.locator('[data-testid="tts-job-input"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="tts-import-btn"]')).toHaveCount(0)

    // Under 401, fetchMyScripts() fails → component renders error box + retry,
    // OR empty-state. Either way the editor page itself must remain visible.
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    const anyState = page.locator(
      'button:has-text("다시 시도"), div:has-text("불러오기 실패"), div:has-text("저장된 대본이 없습니다"), [data-testid="script-picker-list"]'
    )
    await expect(anyState.first()).toBeVisible({ timeout: 8_000 })
  })

  test('TTS tab with empty script list shows empty-state message', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Stub fetchMyScripts API endpoint to return an empty array.
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        // The TTS tab calls /api/my-scripts (or similar) — stub any scripts endpoint.
        if (url.includes('/api/my-scripts') || url.includes('/api/scripts')) {
          return Promise.resolve(
            new Response('[]', {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    await switchToTab(launched, 'tts')
    // fetchMyScripts resolves to [] → empty-state message shown.
    await expect(
      page.getByText('저장된 대본이 없습니다.')
    ).toBeVisible({ timeout: 8_000 })
  })

  test('TTS tab script row with TTS shows badge; disabled row has reduced opacity', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // listMyScripts() expects { products: [...], scripts: [...] } from /api/my-scripts.
    // fetchScriptTtsState() calls getMyScript(productId, scriptId) → /api/products/{id}/scripts/{id}
    // to check detail.meta?.tts?.job.
    // We stub both to return the correct shapes so the TTS component can render the picker.
    const fakeApiResponse = {
      products: [{ id: 1, name: '테스트 상품' }],
      scripts: [
        {
          id: 'script-with-tts',
          product_id: 1,
          title: '대본 TTS 있음',
          persona_name: null,
          ref_shortcode: null,
          created_at: new Date().toISOString()
        },
        {
          id: 'script-no-tts',
          product_id: 1,
          title: '대본 TTS 없음',
          persona_name: null,
          ref_shortcode: null,
          created_at: new Date().toISOString()
        }
      ]
    }

    // Stub window.fetch: /api/my-scripts → script list; detail endpoints → TTS state.
    await page.evaluate((fakeResp) => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/my-scripts')) {
          return Promise.resolve(
            new Response(JSON.stringify(fakeResp), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        // Detail endpoint for script-with-tts — has a TTS job with final_url.
        if (url.includes('script-with-tts')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                meta: {
                  tts: {
                    job: {
                      job_id: 'tts-job-abc',
                      final_url: '/storage/v1/object/fake.mp3'
                    }
                  }
                }
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        // Detail endpoint for script-no-tts — no TTS job.
        if (url.includes('script-no-tts')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ meta: {} }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    }, fakeApiResponse)

    await switchToTab(launched, 'tts')
    // Both rows must be rendered inside the picker list.
    await expect(page.locator('[data-testid="script-picker-list"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="script-row-script-with-tts"]')).toBeVisible()
    await expect(page.locator('[data-testid="script-row-script-no-tts"]')).toBeVisible()

    // The disabled row (no TTS) must carry the reduced-opacity style (0.45).
    const disabledRow = page.locator('[data-testid="script-row-script-no-tts"]')
    const opacity = await disabledRow.evaluate((el) => getComputedStyle(el).opacity)
    expect(parseFloat(opacity)).toBeLessThanOrEqual(0.5)
  })

  // ── 7. AI tab UI (로컬 이미지 업로드 — Phase 1 보강 후) ──────────────────
  //
  // 변경: image URL 텍스트 입력(ai-image-input) → 로컬 파일 업로드 UI.
  // - ai-image-file: 숨겨진 <input type="file">
  // - ai-image-pick-btn: "이미지 선택" 버튼
  // - ai-submit-btn: 업로드 완료 전까지 disabled 상태.
  // 과거 ai-image-input testid는 존재하지 않는다.

  test('AI tab renders prompt textarea + image pick button + submit button (no URL input)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'ai')

    // Old image URL input must NOT be present — it was replaced by file upload.
    await expect(page.locator('[data-testid="ai-image-input"]')).toHaveCount(0)

    // New elements must all exist.
    await expect(page.locator('[data-testid="ai-prompt-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="ai-image-pick-btn"]')).toBeVisible()
    // Hidden file input is in the DOM but not visible.
    await expect(page.locator('[data-testid="ai-image-file"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="ai-submit-btn"]')).toBeVisible()
    await expect(page.locator('[data-testid="ai-submit-btn"]')).toHaveText(
      '백그라운드로 생성 시작'
    )
  })

  test('AI tab image pick button label reads "이미지 선택" initially', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'ai')
    await expect(page.locator('[data-testid="ai-image-pick-btn"]')).toHaveText('이미지 선택')
  })

  test('AI tab submit button is disabled when no image has been uploaded', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'ai')
    // Submit button is disabled until uploadPhase === 'done' — never enabled without a file.
    const submitBtn = page.locator('[data-testid="ai-submit-btn"]')
    await expect(submitBtn).toBeDisabled()
  })

  test('AI tab submit without prompt shows error notice, not crash', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await switchToTab(launched, 'ai')

    // To enable the submit button we must simulate a successful image upload.
    // Step 1 — stub the upload endpoint so no real network call is made.
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/seedance/upload')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ image_url: 'https://fake-cdn.example.com/img.jpg' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    // Step 2 — attach a tiny 1x1 PNG to the hidden file input.
    // The component reads file.arrayBuffer() then calls uploadSeedanceImage → fetch.
    const fileInput = page.locator('[data-testid="ai-image-file"]')
    await fileInput.setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      // Minimal valid 1×1 transparent PNG (67 bytes).
      buffer: Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
        'hex'
      )
    })

    // Wait for upload to complete → button becomes enabled.
    await expect(page.locator('[data-testid="ai-submit-btn"]')).toBeEnabled({ timeout: 8_000 })
    // Prompt is still empty → onNotice('프롬프트를 입력하세요', 'error').
    await page.locator('[data-testid="ai-submit-btn"]').click()
    await expect(
      page.locator('[role="button"]:has-text("프롬프트를 입력하세요")')
    ).toBeVisible({ timeout: 3_000 })
  })

  test('AI tab: after upload done, submit with prompt triggers image-upload guard if imageUrl empty', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // This test verifies the guard message when submitSeedanceJob is called with
    // an imageUrl that is falsy. Since the submit button requires uploadPhase==='done'
    // to be enabled, we simulate a successful upload first, then verify the happy-path
    // guard: prompt filled + image uploaded → submit is accepted (not an error path).
    //
    // The guard "시작 이미지를 업로드하세요" fires when imageUrl is empty despite the
    // button being enabled. In the real component this can only happen if uploadPhase
    // is 'done' but imageUrl is somehow empty — a race that is not user-reachable.
    // We therefore test the complementary observable: after a successful upload
    // the submit button IS enabled and is NOT gated by the image guard.
    await switchToTab(launched, 'ai')

    // Stub upload and Seedance submission endpoints.
    await page.evaluate(() => {
      const orig = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url || String(input)
        if (url.includes('/api/seedance/upload')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ image_url: 'https://fake-cdn.example.com/img.jpg' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        // Fail the generation submission with a known error so we can assert no image guard fires.
        if (url.includes('/api/seedance') && !url.includes('upload')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: 'e2e-stub-submit-disabled' }),
              { status: 500, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        return orig.call(window, input, init)
      }) as typeof fetch
    })

    // Attach tiny PNG + fill prompt.
    const fileInput = page.locator('[data-testid="ai-image-file"]')
    await fileInput.setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
        'hex'
      )
    })
    await expect(page.locator('[data-testid="ai-submit-btn"]')).toBeEnabled({ timeout: 8_000 })
    await page.locator('[data-testid="ai-prompt-input"]').fill('테스트 프롬프트')

    await page.locator('[data-testid="ai-submit-btn"]').click()

    // The "시작 이미지를 업로드하세요" guard must NOT fire — imageUrl is set.
    // Instead the submission fails with our stub error.
    await expect(
      page.locator('[role="button"]:has-text("시작 이미지를 업로드하세요")')
    ).toHaveCount(0)
    // The submission error OR a success notice appears instead.
    await expect(
      page.locator('[role="button"]')
    ).toBeVisible({ timeout: 5_000 })
  })

  // ── 8. No page errors after using all tabs ────────────────────────────────

  test('no console errors after visiting all tabs and interacting', async () => {
    if (!launched) throw new Error('launch failed')
    const { page, consoleErrors } = launched

    // Visit every tab once.
    for (const key of ['library', 'tts', 'ai', 'internal', 'local']) {
      await switchToTab(launched, key)
      await page.waitForTimeout(150)
    }

    // The error collector was set up AFTER launch+reload in the helper — only
    // captures errors that occur during the test body.
    expect(
      consoleErrors.filter((e) =>
        // Filter out known non-fatal Supabase 401s that the helper stubs suppress,
        // and network errors from the intentional route-fulfillment with 401.
        !/(401|Unauthorized|net::ERR_FAILED|Failed to fetch)/i.test(e)
      ),
      `unexpected console.error messages: ${consoleErrors.join('\n')}`
    ).toHaveLength(0)
  })

  // ── 9. IPC regression: download bridge still exposed ────────────────────

  test('download bridge is still exposed after Phase-1 changes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.waitForFunction(() => !!window.electron?.download, null, { timeout: 5_000 })
    const shape = await page.evaluate(() => {
      const dl = (
        window as unknown as { electron: { download: Record<string, unknown> } }
      ).electron.download
      return {
        hasDownload: !!dl,
        keys: Object.keys(dl).sort()
      }
    })
    expect(shape.hasDownload).toBe(true)
    expect(shape.keys).toContain('downloadVideoToTemp')
  })
})

// ---------------------------------------------------------------------------
// Separate describe block: library tab with 200+items (happy path rendering)
// ---------------------------------------------------------------------------

// Fake Seedance video list shared between tests.
const FAKE_VIDEOS = Array.from({ length: 3 }, (_, i) => ({
  id: `fake-vid-${i}`,
  name: `테스트 영상 ${i + 1}`,
  prompt: `프롬프트 ${i + 1}`,
  video_url: `https://fake-cdn.example.com/v${i}.mp4`,
  resolution: '1080p',
  duration: '4',
  aspect_ratio: '9:16',
  generate_audio: false,
  created_at: new Date().toISOString(),
  meta: null
}))

/**
 * Install an in-page window.fetch stub that returns the fake video list for
 * /api/seedance/videos and falls back to the original fetch for all other
 * URLs (including Supabase auth which the preload auth layer relies on).
 *
 * page.route() doesn't reliably intercept fetch() in Electron renderers
 * running under sandbox:true + contextIsolation:true — inject in-page instead
 * (same technique as auth.spec.ts).
 */
async function stubSeedanceVideos(
  page: import('@playwright/test').Page,
  videos: object[]
): Promise<void> {
  await page.evaluate((fakeData: object[]) => {
    const orig = window.fetch
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url || String(input)
      if (url.includes('/api/seedance/videos')) {
        return Promise.resolve(
          new Response(JSON.stringify(fakeData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      return orig.call(window, input, init)
    }) as typeof fetch
  }, videos)
}

test.describe('@phase-1-import-panel library tab happy path (200 + items)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    // Stub the API before opening the editor so the fetch is intercepted when
    // the VideoLibraryTab component mounts.
    await stubSeedanceVideos(page, FAKE_VIDEOS)
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
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

  test('library tab renders remote-grid when API returns videos', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.locator('[data-testid="import-tab-library"]').click()
    // Wait for fetch to complete and grid to appear.
    await expect(page.locator('[data-testid="remote-grid"]')).toBeVisible({
      timeout: 8_000
    })
    // All 3 fake tiles must be rendered.
    for (let i = 0; i < 3; i++) {
      await expect(
        page.locator(`[data-testid="remote-tile-fake-vid-${i}"]`)
      ).toBeVisible()
    }
  })

  test('clicking a library tile with no-download stub shows error notice', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.locator('[data-testid="import-tab-library"]').click()
    await expect(page.locator('[data-testid="remote-grid"]')).toBeVisible({
      timeout: 8_000
    })

    // Override window.electron.download.downloadVideoToTemp to return a
    // failure result so we don't actually try to download a fake CDN URL.
    await page.evaluate(() => {
      window.electron.download.downloadVideoToTemp = async () => ({
        ok: false as const,
        localPath: '',
        sizeBytes: 0,
        error: 'e2e-stub: download disabled'
      })
    })

    // Click the first tile — importFromUrl calls downloadVideoToTemp → fails
    // → component calls onNotice with kind='error'.
    await page.locator('[data-testid="remote-tile-fake-vid-0"]').click()
    // The error banner is a div[role="button"] (errorRow with onClick).
    await expect(
      page.locator('[role="button"]:has-text("가져오기 실패")')
    ).toBeVisible({ timeout: 5_000 })
  })

  test('dragging a library tile to the timeline waits for pending import and creates a clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

    await page.locator('[data-testid="import-tab-library"]').click()
    await expect(page.locator('[data-testid="remote-grid"]')).toBeVisible({
      timeout: 8_000
    })

    await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => {
              addMedia: (asset: unknown) => void
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      const pending = (
        window as unknown as {
          __PENDING_IMPORT_FOR_TEST__: {
            mime: string
            newPendingId: () => string
            registerPending: (
              tempId: string,
              promise: Promise<unknown>,
              displayName: string
            ) => void
          }
        }
      ).__PENDING_IMPORT_FOR_TEST__
      const asset = {
        id: 'pending-library-media',
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName: 'Fake Video 0',
        fileSizeBytes: 0
      }
      store.getState().addMedia(asset)
      const tempId = pending.newPendingId()
      pending.registerPending(
        tempId,
        new Promise((resolve) => setTimeout(() => resolve(asset), 100)),
        'Fake Video 0'
      )
      ;(window as unknown as { __TEST_PENDING_DROP__: { mime: string; tempId: string } }).__TEST_PENDING_DROP__ = {
        mime: pending.mime,
        tempId
      }
    }, fixture)

    await page.evaluate(() => {
      const lane = document.querySelector(
        '[data-testid="track-lane-video"]'
      ) as HTMLElement | null
      if (!lane) throw new Error('lane missing')
      const pending = (
        window as unknown as { __TEST_PENDING_DROP__: { mime: string; tempId: string } }
      ).__TEST_PENDING_DROP__
      const dt = new DataTransfer()
      dt.setData(pending.mime, pending.tempId)
      const rect = lane.getBoundingClientRect()
      const clientX = rect.left + 90
      const clientY = rect.top + rect.height / 2
      lane.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: dt
        })
      )
      lane.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: dt
        })
      )
    })

    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __PROJECT_STORE_FOR_TEST__: {
              getState: () => {
                project: {
                  tracks: Array<{ kind: string; clips: unknown[] }>
                }
              }
            }
          }
        ).__PROJECT_STORE_FOR_TEST__
          .getState()
          .project.tracks.find((t) => t.kind === 'video')?.clips.length === 1,
      null,
      { timeout: 8_000 }
    )

    const result = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ kind: string; mediaId: string }>
                }>
                media: Record<string, { fileName: string }>
              }
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      const project = store.getState().project
      const videoTrack = project.tracks.find((t) => t.kind === 'video')
      return {
        clipCount: videoTrack?.clips.length ?? 0,
        mediaNames: Object.values(project.media).map((m) => m.fileName)
      }
    })

    expect(result.clipCount).toBe(1)
    expect(result.mediaNames).toContain('Fake Video 0')
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(1)
  })
})
