/**
 * Phase 3.80 — frame-step preview keys.
 *
 * `,` / `<` moves the playhead one frame BACK.
 * `.` / `>` moves it one frame FORWARD.
 * Frame size is `1000 / project.fps` ms (defaults to 30fps → 33.33ms).
 * Ignored when the focused element is an input / textarea / select.
 *
 * @phase-3-80-frame-step-keys
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __reelsTimelineUi: {
      getState: () => {
        playheadMs: number
        setPlayheadMs: (ms: number) => void
      }
    }
  }
}

test.describe('@phase-3-80-frame-step-keys , and . keys move one frame', () => {
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
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsTimelineUi?: unknown })
          .__reelsTimelineUi,
      null,
      { timeout: 8_000 }
    )
    // Seed the playhead at 1000ms so a step back is still ≥ 0.
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(1000)
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

  test('A-1 . key advances playhead by ~33ms (1 frame at 30fps)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="editor-page"]').click({ force: true })
    const before = await page.evaluate(
      () => window.__reelsTimelineUi.getState().playheadMs
    )
    await page.keyboard.press('.')
    await page.waitForTimeout(120)
    const after = await page.evaluate(
      () => window.__reelsTimelineUi.getState().playheadMs
    )
    expect(after - before).toBeGreaterThanOrEqual(30)
    expect(after - before).toBeLessThanOrEqual(40)
  })

  test('A-2 , key rewinds playhead by ~33ms', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="editor-page"]').click({ force: true })
    const before = await page.evaluate(
      () => window.__reelsTimelineUi.getState().playheadMs
    )
    await page.keyboard.press(',')
    await page.waitForTimeout(120)
    const after = await page.evaluate(
      () => window.__reelsTimelineUi.getState().playheadMs
    )
    expect(before - after).toBeGreaterThanOrEqual(30)
    expect(before - after).toBeLessThanOrEqual(40)
  })

  test('A-3 playhead never goes negative', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(0)
    })
    await page.locator('[data-testid="editor-page"]').click({ force: true })
    await page.keyboard.press(',')
    await page.waitForTimeout(120)
    const v = await page.evaluate(
      () => window.__reelsTimelineUi.getState().playheadMs
    )
    expect(v).toBe(0)
  })
})
