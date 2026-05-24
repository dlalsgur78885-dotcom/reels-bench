/**
 * Phase 3.83 — A/B loop range.
 *
 * Tests the store action (clamp + reorder) and that the Transport rAF
 * loop wraps the playhead back to `start` when it crosses `end`.
 *
 * @phase-3-83-loop-range
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __reelsTimelineUi: {
      getState: () => {
        playheadMs: number
        playing: boolean
        loopRangeMs: [number, number] | null
        setPlayheadMs: (ms: number) => void
        setPlaying: (p: boolean) => void
        setLoopRange: (r: [number, number] | null) => void
      }
    }
  }
}

test.describe('@phase-3-83-loop-range A/B loop', () => {
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

  test('A-1 setLoopRange clamps + orders (a > b → swap)', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      window.__reelsTimelineUi.getState().setLoopRange([5000, 2000])
      return window.__reelsTimelineUi.getState().loopRangeMs
    })
    expect(r).toEqual([2000, 5000])
  })

  test('A-2 zero-length loop rejected; loopRangeMs unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      window.__reelsTimelineUi.getState().setLoopRange([1000, 1000])
      return window.__reelsTimelineUi.getState().loopRangeMs
    })
    expect(r).toBeNull()
  })

  test('A-3 setLoopRange(null) clears', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setLoopRange([100, 500])
      ui.setLoopRange(null)
      return window.__reelsTimelineUi.getState().loopRangeMs
    })
    expect(r).toBeNull()
  })

  test('A-4 invalid input (NaN / wrong shape) ignored', async () => {
    if (!launched) throw new Error('launch failed')
    const r = await launched.page.evaluate(() => {
      window.__reelsTimelineUi
        .getState()
        .setLoopRange([Number.NaN, 100] as unknown as [number, number])
      return window.__reelsTimelineUi.getState().loopRangeMs
    })
    expect(r).toBeNull()
  })

  test('A-5 Transport rAF wraps playhead back to start when loop active', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // Configure a tight loop [200, 400] and start at 350ms playing.
    await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      ui.setLoopRange([200, 400])
      ui.setPlayheadMs(350)
      ui.setPlaying(true)
    })
    // After 1.5s of real time the playhead should have wrapped at least once
    // and now sit within [200, 400] (not past 400 + tolerance).
    await page.waitForTimeout(1500)
    const v = await page.evaluate(() => {
      const ui = window.__reelsTimelineUi.getState()
      return { ms: ui.playheadMs, playing: ui.playing }
    })
    expect(v.playing).toBe(true)
    expect(v.ms).toBeGreaterThanOrEqual(200)
    expect(v.ms).toBeLessThanOrEqual(450)
  })
})
