/**
 * Phase 3.58 — preview master audio meter.
 *
 * Tap a real-time peak + RMS meter on PreviewAudioGraph's masterGain →
 * destination edge so the user can monitor preview level without
 * clipping. The meter is passive — it only reads the analyser; pause /
 * play / mute logic is untouched.
 *
 * Layer A (store): PreviewAudioGraph.getMasterLevels() — silence (no
 * playback) returns { peak: -Infinity, rms: -Infinity }; the analyser
 * is created with the master graph and never throws.
 *
 * Layer B (UI): the AudioMeter component mounts in the Editor preview
 * overlay; both peak + RMS bars + dB readouts are present; at rest the
 * readouts show "−∞".
 *
 * @phase-3-58-audio-meter
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __previewAudioGraph: {
      masterLevels: () => { peak: number; rms: number }
      isReady: () => boolean
      resume: () => Promise<void>
    }
  }
}

test.describe('@phase-3-58-audio-meter master audio meter', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched!
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
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

  async function openEditor(): Promise<void> {
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
        !!(window as unknown as { __previewAudioGraph?: unknown })
          .__previewAudioGraph,
      null,
      { timeout: 8_000 }
    )
  }

  test('A-1 masterLevels at rest returns -Infinity for peak + RMS (silence floor)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    // Resume context to materialize the AudioContext + analyser.
    await launched.page.evaluate(async () => {
      await window.__previewAudioGraph.resume().catch(() => {})
    })
    const levels = await launched.page.evaluate(() =>
      window.__previewAudioGraph.masterLevels()
    )
    expect(levels.peak).toBe(-Infinity)
    expect(levels.rms).toBe(-Infinity)
  })

  test('A-2 masterLevels never throws even when context is not yet ready', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    // Don't resume — call masterLevels immediately. Should return floor pair.
    const levels = await launched.page.evaluate(() => {
      try {
        return window.__previewAudioGraph.masterLevels()
      } catch (e) {
        return { peak: NaN, rms: NaN, error: String(e) }
      }
    })
    // No error field, both fields are <= 0 (Infinity floor or a real value).
    expect((levels as { error?: string }).error).toBeUndefined()
    expect(levels.peak).toBeLessThanOrEqual(0)
    expect(levels.rms).toBeLessThanOrEqual(0)
  })

  test('B-1 AudioMeter mounts in the preview overlay with peak + RMS bars', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await expect(page.locator('[data-testid="audio-meter"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="audio-meter-peak-bar"]')
    ).toBeAttached()
    await expect(
      page.locator('[data-testid="audio-meter-rms-bar"]')
    ).toBeAttached()
    await expect(
      page.locator('[data-testid="audio-meter-peak-db"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="audio-meter-rms-db"]')
    ).toBeVisible()
  })

  test('B-2 at rest both dB readouts render the −∞ floor', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    // Give the polling loop one tick to render the initial silence reading.
    await page.waitForTimeout(120)
    const peakText = await page
      .locator('[data-testid="audio-meter-peak-db"]')
      .textContent()
    const rmsText = await page
      .locator('[data-testid="audio-meter-rms-db"]')
      .textContent()
    expect(peakText).toContain('−∞')
    expect(rmsText).toContain('−∞')
  })

  test('B-3 peak + RMS bars are zero-width at rest', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.waitForTimeout(120)
    const peakWidth = await page
      .locator('[data-testid="audio-meter-peak-bar"]')
      .evaluate(
        (el) => (el as HTMLElement).style.width
      )
    const rmsWidth = await page
      .locator('[data-testid="audio-meter-rms-bar"]')
      .evaluate(
        (el) => (el as HTMLElement).style.width
      )
    expect(peakWidth).toBe('0%')
    expect(rmsWidth).toBe('0%')
  })
})
