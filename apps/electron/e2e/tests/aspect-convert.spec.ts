/**
 * Phase 3.26 — Aspect-ratio conversion tests.
 *
 * Covers:
 *  (1)  Convert changes project dims — all 4 ratios → correct width/height/aspectRatio.
 *  (2)  Clips survive + still export — clip fields unchanged after convert; buildPlan ok=true.
 *  (3)  Preview re-fits — preview-fitted-rect data attributes reflect new project dims ratio.
 *  (4)  Undo restores in one step — exactly one past entry consumed by a single setAspectRatio.
 *  (5)  Round-trip no drift — 9:16 → 16:9 → 9:16 restores exact dims; clips byte-identical.
 *  (6)  Export byte-identical for a fixed preset — filterGraph unchanged before/after convert.
 *  (7)  Export-mismatch hint — visible for mismatched preset; gone when preset matches project.
 *  (8)  Empty project — setAspectRatio with no clips → no crash, dims update.
 *  (9)  aspectRatioConversion unit — each ratio → correct {aspectRatio, width, height}.
 *  (10) UI — aspect-ratio-select <select> dropdown updates the project via store.
 *
 * @phase-3-26-aspect-convert
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Local type aliases (avoid importing from src to keep tests portable)
// ---------------------------------------------------------------------------
type AspectRatio = '9:16' | '1:1' | '16:9' | '4:5'

type ReelsStore = {
  state: () => {
    project: {
      id: string
      aspectRatio: AspectRatio
      width: number
      height: number
      fps: number
      tracks: Array<{
        id: string
        kind: string
        clips: Array<Record<string, unknown>>
      }>
      media: Record<string, unknown>
    }
  }
  setAspectRatio: (ratio: AspectRatio) => void
  addMedia: (a: unknown) => void
  addClip: (c: unknown) => void
  newId: () => string
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-26-aspect-convert aspect-ratio conversion', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => { createNew: () => void } }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 900))
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

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )
  }

  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
  }

  async function addVideoClip(mediaId: string, durationMs: number, startMs = 0): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mid, dur, st }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!track) throw new Error('no video track')
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

  async function getProjectDims(): Promise<{
    aspectRatio: AspectRatio
    width: number
    height: number
  }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const { aspectRatio, width, height } = reels.state().project
      return { aspectRatio, width, height }
    })
  }

  async function setAspectRatioViaStore(ratio: AspectRatio): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate((r: AspectRatio) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setAspectRatio(r)
    }, ratio)
  }

  async function getClipFromState(clipId: string): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips)
          if ((c as { id?: string }).id === cid) return c
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  async function getHistoryPastCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(() => {
      const t = (
        window as unknown as {
          __reelsUndoRedo: { getState: () => { pastStates: unknown[] } }
        }
      ).__reelsUndoRedo
      return t.getState().pastStates.length
    })
  }

  async function doUndo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsUndoRedo: { getState: () => { undo: () => void } }
        }
      ).__reelsUndoRedo.getState().undo()
    })
  }

  /** Sleep past the zundo throttle window (200ms) so mutations become distinct entries. */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  // ---------------------------------------------------------------------------
  // (1) Convert changes project dims — all 4 ratios
  // ---------------------------------------------------------------------------
  test('(1) @phase-3-26-aspect-convert all 4 ratios set correct width×height and aspectRatio', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()

    const cases: Array<{ ratio: AspectRatio; width: number; height: number }> = [
      { ratio: '9:16', width: 1080, height: 1920 },
      { ratio: '1:1',  width: 1080, height: 1080 },
      { ratio: '16:9', width: 1920, height: 1080 },
      { ratio: '4:5',  width: 1080, height: 1350 }
    ]

    for (const { ratio, width, height } of cases) {
      await setAspectRatioViaStore(ratio)
      const dims = await getProjectDims()
      expect(dims.aspectRatio, `aspectRatio for ${ratio}`).toBe(ratio)
      expect(dims.width,       `width for ${ratio}`).toBe(width)
      expect(dims.height,      `height for ${ratio}`).toBe(height)
    }
  })

  // ---------------------------------------------------------------------------
  // (2) Clips survive + still export — clip fields are UNCHANGED after convert
  // ---------------------------------------------------------------------------
  test('(2) @phase-3-26-aspect-convert clip fields unchanged after aspect convert; buildPlan ok', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Snapshot clip state BEFORE conversion
    const before = await getClipFromState(cid)
    expect(before).not.toBeNull()

    // Convert to 1:1
    await setAspectRatioViaStore('1:1')

    // Clip state AFTER conversion — must be byte-identical
    const after = await getClipFromState(cid)
    expect(after).not.toBeNull()
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))

    // buildPlan must still succeed and produce no NaN in the graph
    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `aspect-plan-${Date.now()}.mp4`)
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPath }
    )
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    expect(result.filterGraph ?? '').not.toContain('NaN')
  })

  // ---------------------------------------------------------------------------
  // (3) Preview re-fits — data-fitted-width / data-fitted-height reflect project dims ratio
  // ---------------------------------------------------------------------------
  test('(3) @phase-3-26-aspect-convert preview-fitted-rect aspect matches project dims after convert', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Convert to 1:1 (square)
    await setAspectRatioViaStore('1:1')
    await page.waitForTimeout(300)

    // Wait for the fitted rect to exist with positive dimensions
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="preview-fitted-rect"]') as HTMLElement | null
        if (!el) return false
        const w = parseInt(el.getAttribute('data-fitted-width') ?? '0', 10)
        const h = parseInt(el.getAttribute('data-fitted-height') ?? '0', 10)
        return w > 0 && h > 0
      },
      null,
      { timeout: 5_000 }
    )

    const rect11 = await page.locator('[data-testid="preview-fitted-rect"]').evaluate((el) => ({
      w: parseInt(el.getAttribute('data-fitted-width') ?? '0', 10),
      h: parseInt(el.getAttribute('data-fitted-height') ?? '0', 10)
    }))

    // For a 1:1 project the fitted rect must be square (w ≈ h within 2%)
    expect(rect11.w).toBeGreaterThan(0)
    expect(rect11.h).toBeGreaterThan(0)
    expect(Math.abs(rect11.w / rect11.h - 1.0)).toBeLessThan(0.02)

    // Convert to 9:16 and verify height > width (portrait)
    await setAspectRatioViaStore('9:16')
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="preview-fitted-rect"]') as HTMLElement | null
        if (!el) return false
        const w = parseInt(el.getAttribute('data-fitted-width') ?? '0', 10)
        const h = parseInt(el.getAttribute('data-fitted-height') ?? '0', 10)
        // 9:16 → h/w ≈ 1.778 — height clearly greater than width
        return w > 0 && h > w
      },
      null,
      { timeout: 5_000 }
    )
    const rect916 = await page.locator('[data-testid="preview-fitted-rect"]').evaluate((el) => ({
      w: parseInt(el.getAttribute('data-fitted-width') ?? '0', 10),
      h: parseInt(el.getAttribute('data-fitted-height') ?? '0', 10)
    }))
    // h/w should be approximately 16/9 ≈ 1.778
    expect(rect916.h / rect916.w).toBeGreaterThan(1.5)
  })

  // ---------------------------------------------------------------------------
  // (4) Undo restores in one step
  // ---------------------------------------------------------------------------
  test('(4) @phase-3-26-aspect-convert undo after setAspectRatio restores dims in exactly one history step', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Establish a known starting ratio
    await setAspectRatioViaStore('9:16')
    await tick()

    const dimsBefore = await getProjectDims()
    expect(dimsBefore.aspectRatio).toBe('9:16')
    expect(dimsBefore.width).toBe(1080)
    expect(dimsBefore.height).toBe(1920)

    const pastBefore = await getHistoryPastCount()

    // Convert to 1:1 — one distinct entry
    await setAspectRatioViaStore('1:1')
    await tick()

    const dimsAfterConvert = await getProjectDims()
    expect(dimsAfterConvert.aspectRatio).toBe('1:1')

    const pastAfterConvert = await getHistoryPastCount()
    // Exactly one new entry pushed
    expect(pastAfterConvert - pastBefore).toBe(1)

    // Undo once
    await doUndo()
    await page.waitForTimeout(200)

    // Dims restored
    const dimsAfterUndo = await getProjectDims()
    expect(dimsAfterUndo.aspectRatio).toBe('9:16')
    expect(dimsAfterUndo.width).toBe(1080)
    expect(dimsAfterUndo.height).toBe(1920)

    // History decremented by exactly 1
    const pastAfterUndo = await getHistoryPastCount()
    expect(pastAfterConvert - pastAfterUndo).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // (5) Round-trip no drift — 9:16 → 16:9 → 9:16 restores exact dims + clips intact
  // ---------------------------------------------------------------------------
  test('(5) @phase-3-26-aspect-convert 9:16 → 16:9 → 9:16 round-trip: clips and dims unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Baseline ratio 9:16
    await setAspectRatioViaStore('9:16')

    // Snapshot clip and dims before round-trip
    const clipBefore = await getClipFromState(cid)
    const dimsBefore = await getProjectDims()

    // Round-trip: 9:16 → 16:9 → 9:16
    await setAspectRatioViaStore('16:9')
    await setAspectRatioViaStore('9:16')

    // Dims must be exactly restored
    const dimsAfter = await getProjectDims()
    expect(dimsAfter.aspectRatio).toBe(dimsBefore.aspectRatio)
    expect(dimsAfter.width).toBe(dimsBefore.width)
    expect(dimsAfter.height).toBe(dimsBefore.height)

    // Clip must be byte-identical
    const clipAfter = await getClipFromState(cid)
    expect(clipAfter).not.toBeNull()
    expect(JSON.stringify(clipAfter)).toBe(JSON.stringify(clipBefore))

    // Full track structure also preserved (compare clip arrays across tracks)
    const tracksBefore = await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      // Reset to snapshot tracks by verifying all clip ids still present
      return reels.state().project.tracks.map((t) =>
        t.clips.map((c) => (c as { id?: string }).id)
      )
    })
    // The same clips should exist (at minimum cid is present)
    const flatIds = (tracksBefore as string[][]).flat()
    expect(flatIds).toContain(cid)
  })

  // ---------------------------------------------------------------------------
  // (6) Export byte-identical for a fixed preset before and after convert
  // ---------------------------------------------------------------------------
  test('(6) @phase-3-26-aspect-convert buildPlan filterGraph unchanged before and after aspect convert', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Start at 9:16
    await setAspectRatioViaStore('9:16')

    const outPathBefore = path.join(
      os.tmpdir(), 'reels-studio-e2e', `aspect-fg-before-${Date.now()}.mp4`
    )
    const planBefore = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPathBefore }
    )
    expect(planBefore.ok).toBe(true)
    const fgBefore = planBefore.filterGraph as string

    // Convert to 1:1 — export pipeline must be unaffected (reads preset, not project dims)
    await setAspectRatioViaStore('1:1')

    const outPathAfter = path.join(
      os.tmpdir(), 'reels-studio-e2e', `aspect-fg-after-${Date.now()}.mp4`
    )
    const planAfter = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPathAfter }
    )
    expect(planAfter.ok).toBe(true)
    const fgAfter = planAfter.filterGraph as string

    // instagram-reels preset is always 1080×1920 regardless of project.aspectRatio
    expect(fgAfter).toBe(fgBefore)
  })

  // ---------------------------------------------------------------------------
  // (7) Export-mismatch hint visibility
  // ---------------------------------------------------------------------------
  test('(7) @phase-3-26-aspect-convert export-aspect-mismatch-hint visible for mismatched preset; gone when matching', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Set project to 1:1
    await setAspectRatioViaStore('1:1')

    // Open ExportDialog
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()

    // Select a 9:16 preset (instagram-reels) — project is 1:1, mismatch expected
    await page.locator('[data-testid="export-preset-instagram-reels"]').click()
    await expect(
      page.locator('[data-testid="export-aspect-mismatch-hint"]')
    ).toBeVisible({ timeout: 4_000 })

    // Select the 1:1 preset (instagram-feed) — project is 1:1, no mismatch
    await page.locator('[data-testid="export-preset-instagram-feed"]').click()
    await expect(
      page.locator('[data-testid="export-aspect-mismatch-hint"]')
    ).not.toBeVisible({ timeout: 4_000 })
  })

  // ---------------------------------------------------------------------------
  // (8) Empty project — no clips; setAspectRatio must not crash
  // ---------------------------------------------------------------------------
  test('(8) @phase-3-26-aspect-convert setAspectRatio on empty project does not crash and updates dims', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Verify zero clips
    const clipCount = await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      return reels.state().project.tracks.reduce((n, t) => n + t.clips.length, 0)
    })
    expect(clipCount).toBe(0)

    // All conversions on empty project must succeed
    await setAspectRatioViaStore('1:1')
    let dims = await getProjectDims()
    expect(dims.aspectRatio).toBe('1:1')
    expect(dims.width).toBe(1080)
    expect(dims.height).toBe(1080)

    await setAspectRatioViaStore('16:9')
    dims = await getProjectDims()
    expect(dims.aspectRatio).toBe('16:9')
    expect(dims.width).toBe(1920)
    expect(dims.height).toBe(1080)

    await setAspectRatioViaStore('4:5')
    dims = await getProjectDims()
    expect(dims.aspectRatio).toBe('4:5')
    expect(dims.width).toBe(1080)
    expect(dims.height).toBe(1350)

    await setAspectRatioViaStore('9:16')
    dims = await getProjectDims()
    expect(dims.aspectRatio).toBe('9:16')
    expect(dims.width).toBe(1080)
    expect(dims.height).toBe(1920)
  })

  // ---------------------------------------------------------------------------
  // (9) aspectRatioConversion unit — all 4 ratios via store
  // ---------------------------------------------------------------------------
  test('(9) @phase-3-26-aspect-convert aspectRatioConversion returns correct dims for all ratios', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Call setAspectRatio for each ratio and read back state —
    // this exercises the pure aspectRatioConversion helper end-to-end.
    const results = await page.evaluate(async () => {
      type AR = '9:16' | '1:1' | '16:9' | '4:5'
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const ratios: AR[] = ['9:16', '1:1', '16:9', '4:5']
      const out: Array<{ ratio: string; aspectRatio: string; width: number; height: number }> = []
      for (const r of ratios) {
        reels.setAspectRatio(r)
        const { aspectRatio, width, height } = reels.state().project
        out.push({ ratio: r, aspectRatio, width, height })
      }
      return out
    })

    const expected: Record<string, { width: number; height: number }> = {
      '9:16': { width: 1080, height: 1920 },
      '1:1':  { width: 1080, height: 1080 },
      '16:9': { width: 1920, height: 1080 },
      '4:5':  { width: 1080, height: 1350 }
    }

    for (const entry of results) {
      const exp = expected[entry.ratio]
      expect(entry.aspectRatio, `aspectRatio for ${entry.ratio}`).toBe(entry.ratio)
      expect(entry.width,       `width for ${entry.ratio}`).toBe(exp.width)
      expect(entry.height,      `height for ${entry.ratio}`).toBe(exp.height)
    }
  })

  // ---------------------------------------------------------------------------
  // (10) UI — aspect-ratio-select dropdown drives the store
  // ---------------------------------------------------------------------------
  test('(10) @phase-3-26-aspect-convert aspect-ratio-select <select> changes update project dims', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Start from a known state
    await setAspectRatioViaStore('9:16')

    // Use the UI dropdown to change to 1:1
    await page.locator('[data-testid="aspect-ratio-select"]').selectOption('1:1')
    await page.waitForTimeout(200)

    const dims = await getProjectDims()
    expect(dims.aspectRatio).toBe('1:1')
    expect(dims.width).toBe(1080)
    expect(dims.height).toBe(1080)

    // Phase 3.46 — the hint node is kept in the DOM (testid preserved for
    // BC) but visually hidden inside the new topbar layout. Assert presence
    // instead of visibility.
    await expect(page.locator('[data-testid="aspect-ratio-hint"]')).toBeAttached()

    // Use the UI dropdown to change to 16:9
    await page.locator('[data-testid="aspect-ratio-select"]').selectOption('16:9')
    await page.waitForTimeout(200)

    const dims169 = await getProjectDims()
    expect(dims169.aspectRatio).toBe('16:9')
    expect(dims169.width).toBe(1920)
    expect(dims169.height).toBe(1080)
  })
})
