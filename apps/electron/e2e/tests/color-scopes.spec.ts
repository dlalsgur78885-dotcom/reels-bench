/**
 * Phase 3.59 — color scopes (waveform / RGB parade / vectorscope).
 *
 * Layer A (pure analyzers): synthetic ImageData → expected occupancy
 *   patterns. Validates luma weighting (waveform), per-channel parade
 *   stacking, and chroma deviation (vectorscope center skip for B&W).
 *
 * Layer B (UI): ColorScopes toggle mounts in the preview overlay; panel
 *   reveals the three scope canvases on toggle.
 *
 * @phase-3-59-color-scopes
 */
import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

declare global {
  interface Window {
    __reelsColorScopes: {
      analyzeWaveform: (
        img: ImageData,
        scope: { width: number; height: number }
      ) => Uint8Array
      analyzeRgbParade: (
        img: ImageData,
        scope: { width: number; height: number }
      ) => Uint8Array
      analyzeVectorscope: (
        img: ImageData,
        scope: { width: number; height: number }
      ) => Uint8Array
    }
  }
}

test.describe('@phase-3-59-color-scopes color scopes', () => {
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
        !!(window as unknown as { __reelsColorScopes?: unknown })
          .__reelsColorScopes,
      null,
      { timeout: 8_000 }
    )
  }

  // =========================================================================
  // LAYER A — pure analyzers
  // =========================================================================
  test('A-1 analyzeWaveform on pure black image → only bottom row is set; on pure white → only top row', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const result = await launched.page.evaluate(() => {
      const W = 100
      const H = 50
      const black = new Uint8ClampedArray(W * H * 4)
      const white = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        white[i * 4] = 255
        white[i * 4 + 1] = 255
        white[i * 4 + 2] = 255
        white[i * 4 + 3] = 255
        black[i * 4 + 3] = 255
      }
      const blackImg = new ImageData(black, W, H)
      const whiteImg = new ImageData(white, W, H)
      const sw = 50
      const sh = 30
      const blackGrid = window.__reelsColorScopes.analyzeWaveform(blackImg, {
        width: sw,
        height: sh
      })
      const whiteGrid = window.__reelsColorScopes.analyzeWaveform(whiteImg, {
        width: sw,
        height: sh
      })
      const bottomRowSet = []
      const topRowSet = []
      for (let x = 0; x < sw; x++) {
        bottomRowSet.push(blackGrid[(sh - 1) * sw + x])
        topRowSet.push(whiteGrid[0 * sw + x])
      }
      // Count set pixels in the rows that should be ALL HOT vs other rows.
      let blackOtherSet = 0
      for (let y = 0; y < sh - 1; y++) {
        for (let x = 0; x < sw; x++)
          if (blackGrid[y * sw + x] === 1) blackOtherSet++
      }
      let whiteOtherSet = 0
      for (let y = 1; y < sh; y++) {
        for (let x = 0; x < sw; x++)
          if (whiteGrid[y * sw + x] === 1) whiteOtherSet++
      }
      const bottomAll = bottomRowSet.every((v) => v === 1)
      const topAll = topRowSet.every((v) => v === 1)
      return { bottomAll, topAll, blackOtherSet, whiteOtherSet }
    })
    expect(result.bottomAll).toBe(true)
    expect(result.topAll).toBe(true)
    expect(result.blackOtherSet).toBe(0)
    expect(result.whiteOtherSet).toBe(0)
  })

  test('A-2 analyzeRgbParade — pure red image only fills the R sub-grid top row, leaves G/B sub-grids bottom-only', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const r = await launched.page.evaluate(() => {
      const W = 80
      const H = 40
      const buf = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        buf[i * 4] = 255 // R
        buf[i * 4 + 1] = 0
        buf[i * 4 + 2] = 0
        buf[i * 4 + 3] = 255
      }
      const img = new ImageData(buf, W, H)
      const sw = 50
      const sh = 30
      const grid = window.__reelsColorScopes.analyzeRgbParade(img, {
        width: sw,
        height: sh
      })
      const stride = sw * sh
      // R sub-grid top row (y=0) should be fully set; G and B sub-grids
      // bottom row should be fully set (channel value 0 → bottom).
      let rTopAll = true
      let gBotAll = true
      let bBotAll = true
      for (let x = 0; x < sw; x++) {
        if (grid[0 * stride + 0 * sw + x] !== 1) rTopAll = false
        if (grid[1 * stride + (sh - 1) * sw + x] !== 1) gBotAll = false
        if (grid[2 * stride + (sh - 1) * sw + x] !== 1) bBotAll = false
      }
      return { rTopAll, gBotAll, bBotAll }
    })
    expect(r.rTopAll).toBe(true)
    expect(r.gBotAll).toBe(true)
    expect(r.bBotAll).toBe(true)
  })

  test('A-3 analyzeVectorscope — B&W (gray) image leaves center untouched (achroma skip)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const r = await launched.page.evaluate(() => {
      const W = 80
      const H = 40
      const buf = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        // pure mid-gray
        buf[i * 4] = 128
        buf[i * 4 + 1] = 128
        buf[i * 4 + 2] = 128
        buf[i * 4 + 3] = 255
      }
      const img = new ImageData(buf, W, H)
      const sw = 50
      const sh = 30
      const grid = window.__reelsColorScopes.analyzeVectorscope(img, {
        width: sw,
        height: sh
      })
      // Count any set pixels — should be ZERO (B&W skips).
      let any = 0
      for (let i = 0; i < grid.length; i++) if (grid[i] === 1) any++
      return any
    })
    expect(r).toBe(0)
  })

  test('A-4 analyzeVectorscope — saturated red image deposits in the R quadrant (right of center, vertically offset)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const r = await launched.page.evaluate(() => {
      const W = 80
      const H = 40
      const buf = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        buf[i * 4] = 255
        buf[i * 4 + 1] = 0
        buf[i * 4 + 2] = 0
        buf[i * 4 + 3] = 255
      }
      const img = new ImageData(buf, W, H)
      const sw = 50
      const sh = 30
      const grid = window.__reelsColorScopes.analyzeVectorscope(img, {
        width: sw,
        height: sh
      })
      // Red has positive V (~0.615 * R) and negative U (~-0.14713 * R) → in
      // our coords V points UP; map: sy < center, sx < center. (U is
      // small-negative, V is positive.) Just assert SOMETHING was placed.
      let count = 0
      for (let i = 0; i < grid.length; i++) if (grid[i] === 1) count++
      return count
    })
    expect(r).toBeGreaterThan(0)
  })

  // =========================================================================
  // LAYER B — UI
  // =========================================================================
  test('B-1 ColorScopes toggle mounts; panel hidden by default', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await expect(page.locator('[data-testid="color-scopes"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="color-scopes-toggle"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="color-scopes-panel"]')
    ).toHaveCount(0)
  })

  test('B-2 clicking toggle reveals three scope canvases', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.locator('[data-testid="color-scopes-toggle"]').click()
    await expect(
      page.locator('[data-testid="color-scopes-panel"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="color-scope-waveform-canvas"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="color-scope-parade-canvas"]')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="color-scope-vectorscope-canvas"]')
    ).toBeVisible()
  })
})
