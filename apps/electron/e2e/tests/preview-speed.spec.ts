/**
 * Phase 3.81 — preview playback speed.
 *
 * @phase-3-81-preview-speed
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __reelsTimelineUi: {
      getState: () => {
        previewSpeed: number
        setPreviewSpeed: (s: number) => void
      }
    }
  }
}

test.describe('@phase-3-81-preview-speed select changes playback rate', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({
      timeout: 30_000
    })
    await page.waitForSelector('[data-testid="editor-page"]', {
      state: 'attached',
      timeout: 45_000
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

  test('A-1 select mounts in preview overlay with default value "1"', async () => {
    if (!launched) throw new Error('launch failed')
    const select = launched.page.locator('[data-testid="preview-speed-select"]')
    await expect(select).toBeVisible()
    expect(await select.inputValue()).toBe('1')
  })

  test('A-2 selecting 2 → timelineUi.previewSpeed === 2', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page
      .locator('[data-testid="preview-speed-select"]')
      .selectOption('2')
    await page.waitForTimeout(150)
    const v = await page.evaluate(
      () => window.__reelsTimelineUi.getState().previewSpeed
    )
    expect(v).toBe(2)
  })

  test('A-3 store setter clamps to [0.1, 8]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPreviewSpeed(100)
    })
    expect(
      await page.evaluate(
        () => window.__reelsTimelineUi.getState().previewSpeed
      )
    ).toBe(8)
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPreviewSpeed(0)
    })
    expect(
      await page.evaluate(
        () => window.__reelsTimelineUi.getState().previewSpeed
      )
    ).toBe(0.1)
  })
})
