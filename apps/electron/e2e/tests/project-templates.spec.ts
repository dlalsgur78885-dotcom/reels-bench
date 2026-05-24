/**
 * Phase 3.88 — Home preset-start buttons.
 *
 * @phase-3-88-project-templates
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          aspectRatio: string
          width: number
          height: number
        }
      }
    }
  }
}

test.describe('@phase-3-88-project-templates Home preset-start buttons', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
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

  test('A-1 three preset buttons mount on Home', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await expect(
      page.locator('[data-testid="start-preset-reels"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="start-preset-square"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="start-preset-longform"]')
    ).toBeVisible()
  })

  test('A-2 Reels preset → editor opens at 9:16 (1080×1920)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="start-preset-reels"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __PROJECT_STORE_FOR_TEST__?: unknown })
          .__PROJECT_STORE_FOR_TEST__,
      null,
      { timeout: 8_000 }
    )
    await page.waitForTimeout(300)
    const dims = await page.evaluate(() => {
      const p = window.__PROJECT_STORE_FOR_TEST__.getState().project
      return { ar: p.aspectRatio, w: p.width, h: p.height }
    })
    expect(dims.ar).toBe('9:16')
    expect(dims.w).toBe(1080)
    expect(dims.h).toBe(1920)
  })

  test('A-3 Square preset → 1:1 (1080×1080)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="start-preset-square"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })
    await page.waitForTimeout(300)
    const dims = await page.evaluate(() => {
      const p = window.__PROJECT_STORE_FOR_TEST__.getState().project
      return { ar: p.aspectRatio, w: p.width, h: p.height }
    })
    expect(dims.ar).toBe('1:1')
    expect(dims.w).toBe(1080)
    expect(dims.h).toBe(1080)
  })

  test('A-4 Long-form preset → 16:9 (1920×1080)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="start-preset-longform"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible({
      timeout: 30_000
    })
    await page.waitForTimeout(300)
    const dims = await page.evaluate(() => {
      const p = window.__PROJECT_STORE_FOR_TEST__.getState().project
      return { ar: p.aspectRatio, w: p.width, h: p.height }
    })
    expect(dims.ar).toBe('16:9')
    expect(dims.w).toBe(1920)
    expect(dims.h).toBe(1080)
  })
})
