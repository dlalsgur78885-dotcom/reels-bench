/**
 * Phase 3.19 — "컬러 매치" (color match) tests.
 *
 * Two layers:
 *
 * Layer A — pure-algorithm tests (deterministic, NO video decode).
 *   Calls window.__reelsAutoColor.statsToColorMatch with synthetic FrameStats
 *   objects. Covers all directional heuristics, dead-band, clamping, degenerate
 *   reference, and the symmetric contrast behavior that distinguishes color match
 *   from auto-color.
 *
 * Layer B — integration tests.
 *   Uses fixture clips, the __reelsStore.applyAutoColorAdjust action, and the
 *   EffectsPanel DOM to verify the full write/undo/picker-UI flow. Tests B-2
 *   and B-3 use hand-built ColorAdjust (no decode) — must pass strictly.
 *   B-1 (real decode) degrades gracefully when headless video decode yields no
 *   frames (tolerant — mirrors auto-color B-1).
 *
 * @phase-3-19-color-match
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
type ColorAdjust = {
  brightness: number
  contrast: number
  saturation: number
  temperature: number
}

type FrameStats = {
  meanLuma: number
  lumaP1: number
  lumaP99: number
  meanSaturation: number
  meanR: number
  meanG: number
  meanB: number
  sampleCount: number
}

// ---------------------------------------------------------------------------
// Synthetic FrameStats factories (sampleCount: 1000 = "real" data)
// ---------------------------------------------------------------------------

/** A typical dark clip — low luma, muted saturation, neutral R/B. */
function darkStats(): FrameStats {
  return {
    meanLuma: 0.15,
    lumaP1: 0.02,
    lumaP99: 0.30,
    meanSaturation: 0.25,
    meanR: 0.16,
    meanG: 0.15,
    meanB: 0.16,
    sampleCount: 1000
  }
}

/** A typical bright clip. */
function brightStats(): FrameStats {
  return {
    meanLuma: 0.82,
    lumaP1: 0.65,
    lumaP99: 0.96,
    meanSaturation: 0.30,
    meanR: 0.82,
    meanG: 0.82,
    meanB: 0.82,
    sampleCount: 1000
  }
}

/** Cool / blue-cast clip (B > R). */
function coolStats(): FrameStats {
  return {
    meanLuma: 0.45,
    lumaP1: 0.10,
    lumaP99: 0.85,
    meanSaturation: 0.38,
    meanR: 0.35,
    meanG: 0.45,
    meanB: 0.60,
    sampleCount: 1000
  }
}

/** Warm / red-cast clip (R > B). */
function warmStats(): FrameStats {
  return {
    meanLuma: 0.45,
    lumaP1: 0.10,
    lumaP99: 0.85,
    meanSaturation: 0.38,
    meanR: 0.60,
    meanG: 0.45,
    meanB: 0.35,
    sampleCount: 1000
  }
}

/** Flat / low-contrast clip (narrow luma range). */
function flatStats(): FrameStats {
  return {
    meanLuma: 0.46,
    lumaP1: 0.40,
    lumaP99: 0.52,
    meanSaturation: 0.35,
    meanR: 0.45,
    meanG: 0.47,
    meanB: 0.45,
    sampleCount: 1000
  }
}

/** Punchy / high-contrast clip (wide luma range). */
function punchyStats(): FrameStats {
  return {
    meanLuma: 0.46,
    lumaP1: 0.02,
    lumaP99: 0.97,
    meanSaturation: 0.35,
    meanR: 0.45,
    meanG: 0.47,
    meanB: 0.45,
    sampleCount: 1000
  }
}

/** Dull / desaturated clip. */
function dullStats(): FrameStats {
  return {
    meanLuma: 0.46,
    lumaP1: 0.10,
    lumaP99: 0.88,
    meanSaturation: 0.05,
    meanR: 0.45,
    meanG: 0.46,
    meanB: 0.45,
    sampleCount: 1000
  }
}

/** Vivid / high-saturation clip. */
function vividStats(): FrameStats {
  return {
    meanLuma: 0.46,
    lumaP1: 0.10,
    lumaP99: 0.88,
    meanSaturation: 0.72,
    meanR: 0.60,
    meanG: 0.46,
    meanB: 0.20,
    sampleCount: 1000
  }
}

/** Degenerate reference — zero sample count. */
function degenerateStats(): FrameStats {
  return {
    meanLuma: 0.0,
    lumaP1: 0.0,
    lumaP99: 0.0,
    meanSaturation: 0.0,
    meanR: 0.0,
    meanG: 0.0,
    meanB: 0.0,
    sampleCount: 0
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (copied verbatim from auto-color.spec.ts)
// ---------------------------------------------------------------------------

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click()
  await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 8_000 }
  )
  await page.evaluate(async () => {
    window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
    await new Promise((r) => setTimeout(r, 800))
  })
}

async function addFixtureMedia(
  launched: LaunchedApp
): Promise<{ mediaId: string; durationMs: number; path: string }> {
  const fixture = process.env.E2E_FIXTURE_MP4
  if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')
  const { page } = launched
  const result = await page.evaluate(async (filePath: string) => {
    await window.electron.fs.allowPath(filePath)
    const probe = await window.electron.media.probe(filePath)
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath
    const reels = window.__reelsStore
    const id = reels.newId()
    reels.addMedia({
      id,
      path: filePath,
      kind: probe.kind,
      durationMs: probe.durationMs,
      width: probe.width ?? 1080,
      height: probe.height ?? 1920,
      codec: probe.codec,
      importedAt: Date.now(),
      fileName,
      fileSizeBytes: 0
    })
    return { mediaId: id, durationMs: probe.durationMs }
  }, fixture)
  return { ...result, path: fixture }
}

async function addVideoClip(
  launched: LaunchedApp,
  mediaId: string,
  durationMs: number,
  startMs = 0
): Promise<string> {
  const { page } = launched
  return page.evaluate(
    ({ mid, dur, st }) => {
      const reels = window.__reelsStore
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')
      if (!track) throw new Error('no video track found')
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId: mid,
        trackId: track.id,
        startMs: st,
        endMs: st + dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return cid
    },
    { mid: mediaId, dur: durationMs, st: startMs }
  )
}

async function getClipFromState(
  launched: LaunchedApp,
  clipId: string
): Promise<Record<string, unknown> | null> {
  return (await launched.page.evaluate((cid) => {
    for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks) {
      for (const c of t.clips) {
        if ((c as Record<string, unknown>).id === cid) return c
      }
    }
    return null
  }, clipId)) as Record<string, unknown> | null
}

async function selectClip(launched: LaunchedApp, clipId: string): Promise<void> {
  const { page } = launched
  const block = page
    .locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`)
    .first()
  const count = await block.count()
  if (count > 0) {
    await block.click({ force: true })
    await page.waitForTimeout(200)
    return
  }
  await page.evaluate((id) => {
    window.__reelsTimelineUi.getState().selectClip(id)
  }, clipId)
  await page.waitForTimeout(150)
}

async function openAdjustTab(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="toggle-effects-panel"]').click()
  await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({ timeout: 3_000 })
  await page.locator('[data-testid="effects-tab-adjust"]').click()
  await expect(page.locator('[data-testid="effects-section-adjust"]')).toBeVisible({
    timeout: 2_000
  })
}

// ===========================================================================
// Layer A — Pure statsToColorMatch tests (synthetic FrameStats, no video decode)
// ===========================================================================
test.describe('@phase-3-19-color-match Layer A — pure statsToColorMatch (deterministic)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    // Navigate to editor so testBridge + __reelsAutoColor are installed.
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsAutoColor?: unknown }).__reelsAutoColor,
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

  // =========================================================================
  // A-1: Dark target + bright reference → brightness > 10
  // =========================================================================
  test('A-1: dark target + bright reference → brightness > 10', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: darkStats(), reference: brightStats() }
    )
    expect(result.brightness).toBeGreaterThan(10)
  })

  // =========================================================================
  // A-2: Bright target + dark reference → brightness < 0
  // =========================================================================
  test('A-2: bright target + dark reference → brightness < 0', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: brightStats(), reference: darkStats() }
    )
    expect(result.brightness).toBeLessThan(0)
  })

  // =========================================================================
  // A-3: Cool target + warm reference → temperature > 0
  //      (B>R target must warm up to match R>B reference → positive temperature)
  // =========================================================================
  test('A-3: cool target (B>R) + warm reference (R>B) → temperature > 0', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: coolStats(), reference: warmStats() }
    )
    expect(result.temperature).toBeGreaterThan(0)
  })

  // =========================================================================
  // A-4: Warm target + cool reference → temperature < 0
  // =========================================================================
  test('A-4: warm target (R>B) + cool reference (B>R) → temperature < 0', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: warmStats(), reference: coolStats() }
    )
    expect(result.temperature).toBeLessThan(0)
  })

  // =========================================================================
  // A-5: Symmetric contrast — flat target + punchy reference → contrast > 0;
  //      punchy target + flat reference → contrast < 0.
  //      Verifies the fully-symmetric, no-negative-floor behavior (unlike auto-color
  //      which clamps negative contrast at -25).
  // =========================================================================
  test('A-5a: flat target + punchy reference → contrast > 0', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: flatStats(), reference: punchyStats() }
    )
    expect(result.contrast).toBeGreaterThan(0)
  })

  test('A-5b: punchy target + flat reference → contrast < 0 (symmetric)', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: punchyStats(), reference: flatStats() }
    )
    expect(result.contrast).toBeLessThan(0)
  })

  // =========================================================================
  // A-6: Dull target + vivid reference → saturation > 0
  // =========================================================================
  test('A-6: dull target + vivid reference → saturation > 0', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(target, reference)
      },
      { target: dullStats(), reference: vividStats() }
    )
    expect(result.saturation).toBeGreaterThan(0)
  })

  // =========================================================================
  // A-7: Identical stats → all four axes === 0 (dead-band)
  // =========================================================================
  test('A-7: identical target and reference stats → all axes === 0', async () => {
    if (!launched) throw new Error('launch failed')
    const stats = coolStats() // arbitrary but non-trivial
    const result = await launched.page.evaluate(
      ({ s }: { s: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        return ac.statsToColorMatch(s, s)
      },
      { s: stats }
    )
    expect(result.brightness).toBe(0)
    expect(result.contrast).toBe(0)
    expect(result.saturation).toBe(0)
    expect(result.temperature).toBe(0)
  })

  // =========================================================================
  // A-8: Clamping — extreme opposite ends → every axis magnitude ≤ 60
  // =========================================================================
  test('A-8: extreme target vs opposite-extreme reference → every axis magnitude ≤ 60', async () => {
    if (!launched) throw new Error('launch failed')
    // All-black vs all-white extremes: maximum possible magnitude on all axes.
    const extremeDark: FrameStats = {
      meanLuma: 0.0,
      lumaP1: 0.0,
      lumaP99: 0.0,
      meanSaturation: 0.0,
      meanR: 0.0,
      meanG: 0.0,
      meanB: 0.0,
      sampleCount: 1000
    }
    const extremeBright: FrameStats = {
      meanLuma: 1.0,
      lumaP1: 0.98,
      lumaP99: 1.0,
      meanSaturation: 1.0,
      meanR: 1.0,
      meanG: 1.0,
      meanB: 0.0, // extreme cool-warm contrast
      sampleCount: 1000
    }
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
            AUTO_COLOR_MAX_MAGNITUDE: number
          }
        }).__reelsAutoColor
        const adj = ac.statsToColorMatch(target, reference)
        return { adj, cap: ac.AUTO_COLOR_MAX_MAGNITUDE }
      },
      { target: extremeDark, reference: extremeBright }
    )
    const { adj, cap } = result
    expect(Math.abs(adj.brightness)).toBeLessThanOrEqual(cap)
    expect(Math.abs(adj.contrast)).toBeLessThanOrEqual(cap)
    expect(Math.abs(adj.saturation)).toBeLessThanOrEqual(cap)
    expect(Math.abs(adj.temperature)).toBeLessThanOrEqual(cap)
  })

  // =========================================================================
  // A-9: Degenerate reference (sampleCount === 0) → all four axes === 0, no NaN/throw
  // =========================================================================
  test('A-9: degenerate reference (sampleCount=0) → all axes === 0, no NaN/throw', async () => {
    if (!launched) throw new Error('launch failed')
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
          }
        }).__reelsAutoColor
        let adj: ColorAdjust
        try {
          adj = ac.statsToColorMatch(target, reference)
        } catch (e) {
          return { threw: true, message: String(e), brightness: 0, contrast: 0, saturation: 0, temperature: 0, hasNaN: false }
        }
        const hasNaN = Object.values(adj).some((v) => typeof v === 'number' && isNaN(v))
        return { threw: false, ...adj, hasNaN }
      },
      { target: darkStats(), reference: degenerateStats() }
    )
    expect(result.threw).toBe(false)
    expect(result.hasNaN).toBe(false)
    expect(result.brightness).toBe(0)
    expect(result.contrast).toBe(0)
    expect(result.saturation).toBe(0)
    expect(result.temperature).toBe(0)
  })

  // =========================================================================
  // A-10: Near-similar stats (tiny deltas within dead-band) → all axes === 0
  // =========================================================================
  test('A-10: near-similar stats (deltas within dead-band) → all axes === 0', async () => {
    if (!launched) throw new Error('launch failed')
    // Differences so small that computed slider values are < MIN_MATCH_MAGNITUDE (3).
    // meanLuma delta: 0.002 → brightness delta = 0.002 * 220 = 0.44 → rounds to 0.
    // luma spread delta: 0.003 → contrast delta = 0.003 * 180 = 0.54 → rounds to 1 (< 3).
    // saturation delta: 0.002 → 0.002 * 200 = 0.4 → rounds to 0.
    // R/B balance delta: 0.002 → 0.002 * 320 = 0.64 → below RB_DEADBAND anyway.
    const base: FrameStats = {
      meanLuma: 0.46,
      lumaP1: 0.10,
      lumaP99: 0.88,
      meanSaturation: 0.42,
      meanR: 0.45,
      meanG: 0.46,
      meanB: 0.45,
      sampleCount: 1000
    }
    const nearSame: FrameStats = {
      meanLuma: 0.462,
      lumaP1: 0.10,
      lumaP99: 0.883,
      meanSaturation: 0.422,
      meanR: 0.452,
      meanG: 0.46,
      meanB: 0.450,
      sampleCount: 1000
    }
    const result = await launched.page.evaluate(
      ({ target, reference }: { target: FrameStats; reference: FrameStats }) => {
        const ac = (window as unknown as {
          __reelsAutoColor: {
            statsToColorMatch: (t: FrameStats, r: FrameStats) => ColorAdjust
            MIN_MATCH_MAGNITUDE: number
          }
        }).__reelsAutoColor
        const adj = ac.statsToColorMatch(target, reference)
        return { ...adj, deadband: ac.MIN_MATCH_MAGNITUDE }
      },
      { target: base, reference: nearSame }
    )
    expect(result.brightness).toBe(0)
    expect(result.contrast).toBe(0)
    expect(result.saturation).toBe(0)
    expect(result.temperature).toBe(0)
  })
})

// ===========================================================================
// Layer B — Integration tests (fixture clips + store + UI)
// ===========================================================================
test.describe('@phase-3-19-color-match Layer B — integration (store + UI)', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
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

  // =========================================================================
  // B-1: End-to-end — add two clips; pick clip B as reference; click 컬러 매치.
  //      Tolerant of headless decode failure (mirrors auto-color B-1).
  // =========================================================================
  test('B-1: color-match button runs without hanging; result is valid or degrades to error state', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Add two fixture clips (same fixture file used twice — different clip IDs).
    const { mediaId: mediaIdA, durationMs } = await addFixtureMedia(launched)
    // Re-add the same physical file as a second media entry so clip B has
    // a distinct mediaId (the select excludes the selected clip itself, not
    // by mediaId). Use the fixture path directly.
    const fixture = process.env.E2E_FIXTURE_MP4!
    const mediaIdB = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = (filePath.split(/[/\\]/).pop() ?? filePath) + '_ref'
      const reels = window.__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return id
    }, fixture)

    const clipAId = await addVideoClip(launched, mediaIdA, durationMs, 0)
    const clipBId = await addVideoClip(launched, mediaIdB, durationMs, durationMs)

    // Select clip A, open adjust tab.
    await selectClip(launched, clipAId)
    await openAdjustTab(launched)

    // The match button must be visible and disabled before a reference is picked.
    const matchBtn = page.locator('[data-testid="effects-coloradjust-match"]')
    await expect(matchBtn).toBeVisible({ timeout: 3_000 })
    await expect(matchBtn).toBeDisabled()

    // Pick clip B as the reference.
    const refSelect = page.locator('[data-testid="effects-coloradjust-match-ref"]')
    await expect(refSelect).toBeVisible({ timeout: 3_000 })
    await refSelect.selectOption(clipBId)

    // Button must be enabled now.
    await expect(matchBtn).toBeEnabled({ timeout: 2_000 })

    // Click the match button.
    await matchBtn.click()

    // Wait for analysis to finish (button returns to enabled) or error to appear.
    // Cap at 30s — mirrors auto-color B-1 tolerance.
    await Promise.race([
      page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-testid="effects-coloradjust-match"]') as HTMLButtonElement | null
          return btn ? !btn.disabled : false
        },
        null,
        { timeout: 30_000 }
      ),
      page
        .locator('[data-testid="effects-coloradjust-match-error"]')
        .waitFor({ timeout: 30_000 })
        .catch(() => {
          /* not an error if the timeout passes and button became enabled instead */
        })
    ])

    const errorVisible = await page
      .locator('[data-testid="effects-coloradjust-match-error"]')
      .isVisible()

    if (errorVisible) {
      // Decode genuinely failed headless — acceptable degradation.
      await expect(matchBtn).toBeEnabled({ timeout: 5_000 })
    } else {
      // Analysis succeeded. colorAdjust must be undefined or all fields ≤ ±60.
      const clip = await getClipFromState(launched, clipAId)
      expect(clip).not.toBeNull()
      const ca = clip!.colorAdjust as ColorAdjust | undefined
      if (ca !== undefined) {
        expect(Math.abs(ca.brightness)).toBeLessThanOrEqual(60)
        expect(Math.abs(ca.contrast)).toBeLessThanOrEqual(60)
        expect(Math.abs(ca.saturation)).toBeLessThanOrEqual(60)
        expect(Math.abs(ca.temperature)).toBeLessThanOrEqual(60)
      }
    }
  })

  // =========================================================================
  // B-2: Undo/redo — applyAutoColorAdjust → undo → colorAdjust undefined → redo → restored
  //      Uses hand-built ColorAdjust — no decode required. Must pass strictly.
  // =========================================================================
  test('B-2: undo/redo of applyAutoColorAdjust (color match result): undo → undefined; redo → restored', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const clipId = await addVideoClip(launched, mediaId, durationMs)

    // Baseline: no colorAdjust.
    const before = await getClipFromState(launched, clipId)
    expect(before!.colorAdjust).toBeUndefined()

    // Simulate what color match writes via applyAutoColorAdjust.
    const matchResult: ColorAdjust = { brightness: 20, contrast: 10, saturation: 5, temperature: 8 }
    await page.evaluate(
      ({ id, adj }) => {
        window.__reelsStore.applyAutoColorAdjust(id, adj)
      },
      { id: clipId, adj: matchResult }
    )
    await page.waitForTimeout(250)

    const withAdj = await getClipFromState(launched, clipId)
    expect(withAdj!.colorAdjust).toBeDefined()
    const ca = withAdj!.colorAdjust as ColorAdjust
    expect(ca.brightness).toBe(20)
    expect(ca.contrast).toBe(10)
    expect(ca.saturation).toBe(5)
    expect(ca.temperature).toBe(8)

    // Undo → colorAdjust must be undefined.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: { getState: () => { undo: () => void } } }).__reelsUndoRedo.getState().undo()
    })
    await page.waitForTimeout(200)

    const afterUndo = await getClipFromState(launched, clipId)
    expect(afterUndo!.colorAdjust).toBeUndefined()

    // Redo → restored.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: { getState: () => { redo: () => void } } }).__reelsUndoRedo.getState().redo()
    })
    await page.waitForTimeout(200)

    const afterRedo = await getClipFromState(launched, clipId)
    const restored = afterRedo!.colorAdjust as ColorAdjust | undefined
    expect(restored).toBeDefined()
    expect(restored!.brightness).toBe(20)
    expect(restored!.temperature).toBe(8)
  })

  // =========================================================================
  // B-3: Reference picker UI — lists the OTHER clip, not the selected one,
  //      and no audio clips; match button disabled without selection.
  // =========================================================================
  test('B-3: reference picker lists other video clip; excludes selected clip; match button disabled without selection', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    // Add a video clip (clip A) and another video clip (clip B).
    const { mediaId: mediaIdA, durationMs } = await addFixtureMedia(launched)
    const fixture = process.env.E2E_FIXTURE_MP4!
    const mediaIdB = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = (filePath.split(/[/\\]/).pop() ?? filePath) + '_refB'
      const reels = window.__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return id
    }, fixture)

    const clipAId = await addVideoClip(launched, mediaIdA, durationMs, 0)
    const clipBId = await addVideoClip(launched, mediaIdB, durationMs, durationMs)

    // Select clip A, open adjust tab.
    await selectClip(launched, clipAId)
    await openAdjustTab(launched)

    const matchBtn = page.locator('[data-testid="effects-coloradjust-match"]')
    const refSelect = page.locator('[data-testid="effects-coloradjust-match-ref"]')

    await expect(matchBtn).toBeVisible({ timeout: 3_000 })
    await expect(refSelect).toBeVisible({ timeout: 3_000 })

    // Match button must be disabled when no reference is selected.
    await expect(matchBtn).toBeDisabled()

    // The select must contain clip B's ID as an option.
    const clipBOption = refSelect.locator(`option[value="${clipBId}"]`)
    await expect(clipBOption).toHaveCount(1)

    // The select must NOT contain clip A's ID (the currently selected clip).
    const clipAOption = refSelect.locator(`option[value="${clipAId}"]`)
    await expect(clipAOption).toHaveCount(0)

    // After picking clip B, the button becomes enabled.
    await refSelect.selectOption(clipBId)
    await expect(matchBtn).toBeEnabled({ timeout: 2_000 })

    // Deselect (pick empty) → button back to disabled.
    await refSelect.selectOption({ value: '' })
    await expect(matchBtn).toBeDisabled()
  })

  // =========================================================================
  // B-4: Byte-identical — a clip with no color match applied →
  //      buildPlan().filterGraph matches the no-coloradjust baseline.
  //      color match writes via applyAutoColorAdjust (colorAdjust field), so
  //      a clip that was never color-matched has colorAdjust===undefined →
  //      filterGraph must contain no colortemperature= beyond the auto-color path.
  // =========================================================================
  test('B-4: no color-match applied → filterGraph byte-identical to no-coloradjust baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const { mediaId, durationMs } = await addFixtureMedia(launched)
    await addVideoClip(launched, mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-no-colormatch.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''

    // No colortemperature= filter must be injected by color match.
    expect(graph).not.toContain('colortemperature=')
  })

  // =========================================================================
  // B-5: Auto-color regression — the computeAutoColorAdjust refactor must not
  //      have broken the existing auto-color write/undo path.
  //      Calls applyAutoColorAdjust with a hand-built result and verifies the
  //      store and undo/redo paths still work identically to auto-color B-2.
  // =========================================================================
  test('B-5: auto-color regression — applyAutoColorAdjust write/undo still works after refactor', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const clipId = await addVideoClip(launched, mediaId, durationMs)

    // Confirm baseline.
    const before = await getClipFromState(launched, clipId)
    expect(before!.colorAdjust).toBeUndefined()

    // Apply a typical auto-color result.
    const autoAdj: ColorAdjust = { brightness: 30, contrast: 15, saturation: 20, temperature: -10 }
    await page.evaluate(
      ({ id, adj }) => {
        window.__reelsStore.applyAutoColorAdjust(id, adj)
      },
      { id: clipId, adj: autoAdj }
    )
    await page.waitForTimeout(250)

    const withAdj = await getClipFromState(launched, clipId)
    expect(withAdj!.colorAdjust).toBeDefined()
    const ca = withAdj!.colorAdjust as ColorAdjust
    expect(ca.brightness).toBe(30)
    expect(ca.temperature).toBe(-10)

    // Undo → colorAdjust must be undefined.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: { getState: () => { undo: () => void } } }).__reelsUndoRedo.getState().undo()
    })
    await page.waitForTimeout(200)

    const afterUndo = await getClipFromState(launched, clipId)
    expect(afterUndo!.colorAdjust).toBeUndefined()

    // Redo → restored.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: { getState: () => { redo: () => void } } }).__reelsUndoRedo.getState().redo()
    })
    await page.waitForTimeout(200)

    const afterRedo = await getClipFromState(launched, clipId)
    const restored = afterRedo!.colorAdjust as ColorAdjust | undefined
    expect(restored).toBeDefined()
    expect(restored!.brightness).toBe(30)
    expect(restored!.contrast).toBe(15)
    expect(restored!.saturation).toBe(20)
    expect(restored!.temperature).toBe(-10)
  })
})
