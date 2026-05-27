/**
 * Reels 11 슬라이드 13 — 화면 분리 시 프리뷰 2개 표시 → 한 곳으로 합치기.
 *
 * Contract:
 *  (1) 분리 OFF — preview-canvas 1개만 표시 (메인 그리드 슬롯), placeholder 없음.
 *  (2) 분리 ON — 메인 윈도우는 placeholder 만 표시 + in-app floating 프리뷰
 *      (data-detached='true') 가 더 이상 DOM 에 없음.
 *  (3) 분리 ON — 별도 BrowserWindow 가 열리고 preview-only-toolbar +
 *      preview-only-aot-toggle + preview-only-minimize + preview-only-merge
 *      testid 모두 노출.
 *  (4) 분리 윈도우의 합치기 버튼 → 메인 windows 의 previewDetached=false 로
 *      되돌아오고 placeholder 사라짐.
 *
 * @reels-11-slide-13-preview-detach-merge
 */
import { expect, test } from '@playwright/test'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

test.describe('@reels-11-slide-13-preview-detach-merge 분리 시 중복 제거', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 8_000
    })
    // 토글 진입 전 분리 상태 false 보장.
    await page.evaluate(() => {
      try {
        localStorage.setItem('reels-preview-detached', '0')
      } catch {
        /* ignore */
      }
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

  test('A-1 분리 OFF — placeholder 없음, in-app 프리뷰 1개', async () => {
    const { page } = launched!
    await expect(
      page.locator('[data-testid="preview-detached-placeholder"]')
    ).toHaveCount(0)
    // data-detached 플래그 false 인 div 가 그려져 있어야 함.
    await expect(page.locator('[data-detached="false"]')).toHaveCount(1)
    // 분리 플래그 true 인 in-app floater 는 없음.
    await expect(page.locator('[data-detached="true"]')).toHaveCount(0)
  })

  test('A-2 분리 ON — placeholder 표시 + in-app floater 사라짐', async () => {
    const { page } = launched!
    const toggle = page.locator('[data-testid="preview-detach-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    await toggle.click()
    await expect(
      page.locator('[data-testid="preview-detached-placeholder"]')
    ).toBeVisible({ timeout: 5_000 })
    // 핵심 — in-app floating 프리뷰가 더 이상 DOM 에 없음.
    await expect(page.locator('[data-detached="true"]')).toHaveCount(0)
    // 분리 OFF 상태 div 도 unmount.
    await expect(page.locator('[data-detached="false"]')).toHaveCount(0)
  })

  test('A-3 분리 ON — PreviewOnly 윈도우 + 툴바 testid', async () => {
    const { app, page } = launched!
    const toggle = page.locator('[data-testid="preview-detach-toggle"]')
    await toggle.click()
    // 분리 윈도우는 별도 BrowserWindow 라 firstWindow 가 아닌 새 페이지로 잡힘.
    await page.waitForTimeout(800)
    const pages = app.windows()
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const preview = pages.find((p) => p !== page && p.url().includes('previewOnly=1'))
    expect(preview).toBeTruthy()
    if (!preview) return
    await preview.waitForLoadState('domcontentloaded')
    await expect(preview.locator('[data-testid="preview-only-toolbar"]')).toBeVisible({
      timeout: 5_000
    })
    await expect(
      preview.locator('[data-testid="preview-only-aot-toggle"]')
    ).toBeVisible()
    await expect(
      preview.locator('[data-testid="preview-only-minimize"]')
    ).toBeVisible()
    await expect(preview.locator('[data-testid="preview-only-merge"]')).toBeVisible()
  })

  test('A-4 분리 윈도우 합치기 → 메인의 placeholder 사라지고 in-app 복귀', async () => {
    const { app, page } = launched!
    await page.locator('[data-testid="preview-detach-toggle"]').click()
    await page.waitForTimeout(800)
    const preview = app
      .windows()
      .find((p) => p !== page && p.url().includes('previewOnly=1'))
    expect(preview).toBeTruthy()
    if (!preview) return
    await preview.waitForLoadState('domcontentloaded')
    await preview.locator('[data-testid="preview-only-merge"]').click()
    // 메인 window 의 previewDetached=false 로 돌아옴.
    await expect(
      page.locator('[data-testid="preview-detached-placeholder"]')
    ).toHaveCount(0, { timeout: 5_000 })
    await expect(page.locator('[data-detached="false"]')).toHaveCount(1)
  })

  test('A-5 항상-위 토글 IPC 왕복', async () => {
    const { app, page } = launched!
    await page.locator('[data-testid="preview-detach-toggle"]').click()
    await page.waitForTimeout(800)
    const preview = app
      .windows()
      .find((p) => p !== page && p.url().includes('previewOnly=1'))
    expect(preview).toBeTruthy()
    if (!preview) return
    const aotBtn = preview.locator('[data-testid="preview-only-aot-toggle"]')
    await expect(aotBtn).toBeVisible({ timeout: 5_000 })
    await expect(aotBtn).toHaveAttribute('data-aot-active', 'false')
    await aotBtn.click()
    await expect(aotBtn).toHaveAttribute('data-aot-active', 'true')
    // main process 의 BrowserWindow alwaysOnTop 도 true 여야 함.
    const aotMain = await app.evaluate(({ BrowserWindow }) => {
      const wins = (BrowserWindow as unknown as {
        getAllWindows: () => ElectronBrowserWindow[]
      }).getAllWindows()
      return wins.map((w) => w.isAlwaysOnTop())
    })
    expect(aotMain.some((flag) => flag === true)).toBe(true)
  })
})
