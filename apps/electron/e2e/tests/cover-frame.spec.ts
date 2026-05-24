/**
 * Phase 3.27 — cover / thumbnail frame picker.
 *
 * Contract:
 *   - `Project.coverMs?: number`
 *   - `resolveCoverMs(coverMs, durationMs)` clamps to [0, durationMs]
 *   - `ExportRunResult.coverPath?: string`
 *
 * Export: after the main mp4 encode, a SEPARATE 2nd ffmpeg pass extracts
 * `<name>_cover.jpg`. Best-effort — never fails the export. Main graph is
 * NOT affected by `coverMs`.
 *
 * Renderer: `window.__reelsStore.setCoverMs(ms)` / `clearCoverMs()` (one
 * zundo step each). Timeline shows `ruler-cover-marker` with
 * `data-cover-ms`. ExportDialog shows `export-cover-readout`.
 *
 * @phase-3-27-cover-frame
 */

import { expect, test } from '@playwright/test'
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openOptionsMenu } from '../helpers/topbar'

// ---------------------------------------------------------------------------
// Local type aliases
// ---------------------------------------------------------------------------
type ReelsStore = {
  state: () => {
    project: {
      coverMs?: number
      tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }>
      media: Record<string, unknown>
    }
  }
  setCoverMs: (ms: number) => void
  clearCoverMs: () => void
  addMedia: (a: unknown) => void
  addClip: (c: unknown) => void
  newId: () => string
}

type UndoRedo = {
  getState: () => {
    pastStates: unknown[]
    undo: () => void
    redo: () => void
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-27-cover-frame cover / thumbnail frame picker', () => {
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
  // Helpers
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

  async function getCoverMs(): Promise<number | undefined> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      return reels.state().project.coverMs
    })
  }

  async function getHistoryPastCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(() => {
      const t = (window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo
      return t.getState().pastStates.length
    })
  }

  /** Sleep past the zundo throttle window (200ms) so mutations become distinct entries. */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  async function doUndo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo.getState().undo()
    })
  }

  async function doRedo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo.getState().redo()
    })
  }

  // ---------------------------------------------------------------------------
  // Test 1: Set cover updates coverMs; clear removes it
  // ---------------------------------------------------------------------------
  test('(1) @phase-3-27-cover-frame setCoverMs stores clamped ms; clearCoverMs removes it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Set playhead to a specific position
    const targetMs = Math.floor(durationMs / 2)
    await page.evaluate((ms) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: { getState: () => { setPlayheadMs: (ms: number) => void } }
        }
      ).__reelsTimelineUi
      ui.getState().setPlayheadMs(ms)
    }, targetMs)

    // Click set-cover-frame button (now inside 옵션 ▾ popover).
    await openOptionsMenu(page)
    await page.locator('[data-testid="set-cover-frame"]').click()
    await page.waitForTimeout(100)

    const coverAfterSet = await getCoverMs()
    expect(coverAfterSet, 'coverMs should be set after clicking set-cover-frame').not.toBeUndefined()
    // The value is clamped to [0, durationMs]
    expect(coverAfterSet!).toBeGreaterThanOrEqual(0)
    expect(coverAfterSet!).toBeLessThanOrEqual(durationMs)
    // Should be close to targetMs (within one frame tolerance)
    expect(Math.abs(coverAfterSet! - targetMs)).toBeLessThanOrEqual(100)

    // Click clear-cover-frame button (옵션 popover may close after set-cover; re-open).
    await openOptionsMenu(page)
    await page.locator('[data-testid="clear-cover-frame"]').click()
    await page.waitForTimeout(100)

    const coverAfterClear = await getCoverMs()
    expect(coverAfterClear, 'coverMs should be undefined after clearCoverMs').toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Test 2: Timeline marker
  // ---------------------------------------------------------------------------
  test('(2) @phase-3-27-cover-frame ruler-cover-marker appears with data-cover-ms; gone after clear', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const targetMs = Math.floor(durationMs * 0.4)
    await page.evaluate((ms) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(ms)
    }, targetMs)

    // Marker should appear
    const marker = page.locator('[data-testid="ruler-cover-marker"]')
    await expect(marker).toBeVisible({ timeout: 4_000 })
    const dataCoverMs = await marker.getAttribute('data-cover-ms')
    expect(dataCoverMs).not.toBeNull()
    const parsedMs = parseInt(dataCoverMs ?? '-1', 10)
    expect(parsedMs).toBeGreaterThanOrEqual(0)
    // Clamped to durationMs
    expect(parsedMs).toBeLessThanOrEqual(durationMs)

    // Clear and verify marker gone
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.clearCoverMs()
    })
    await expect(marker).not.toBeVisible({ timeout: 4_000 })
  })

  // ---------------------------------------------------------------------------
  // Test 3: Export produces a valid _cover.jpg
  // ---------------------------------------------------------------------------
  test('(3) @phase-3-27-cover-frame exporter.run with coverMs set produces valid _cover.jpg', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Set coverMs to ~1s into the clip
    const coverTargetMs = 1000
    await page.evaluate((ms) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(ms)
    }, coverTargetMs)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'cover-test')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `cover-frame-${Date.now()}.mp4`)
    const expectedCoverPath = path.join(outDir, path.basename(outPath, '.mp4') + '_cover.jpg')

    // Cleanup before
    if (existsSync(outPath)) {
      try { rmSync(outPath) } catch { /* ignore */ }
    }
    if (existsSync(expectedCoverPath)) {
      try { rmSync(expectedCoverPath) } catch { /* ignore */ }
    }

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-cover-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `export failed: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)

    // coverPath must be set and point to a file
    expect(r.coverPath, 'coverPath should be set in result').toBeTruthy()
    expect(existsSync(r.coverPath as string), `cover file missing at ${r.coverPath}`).toBe(true)
    expect(statSync(r.coverPath as string).size).toBeGreaterThan(100)

    // Validate JPEG magic bytes (FF D8 FF)
    const buf = readFileSync(r.coverPath as string)
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    expect(buf[2]).toBe(0xff)

    // Cleanup
    try { rmSync(outPath) } catch { /* ignore */ }
    try { rmSync(r.coverPath as string) } catch { /* ignore */ }
  })

  // ---------------------------------------------------------------------------
  // Test 4: No-cover fallback — coverMs unset → coverPath still set (frame 0)
  // ---------------------------------------------------------------------------
  test('(4) @phase-3-27-cover-frame no coverMs set → coverPath still produced (frame-0 fallback)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Ensure no cover set
    const coverMs = await getCoverMs()
    expect(coverMs).toBeUndefined()

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'cover-test')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `no-cover-fallback-${Date.now()}.mp4`)

    if (existsSync(outPath)) {
      try { rmSync(outPath) } catch { /* ignore */ }
    }

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-no-cover-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `export failed: ${r.error ?? ''}`).toBe(true)
    // Frame-0 fallback: coverPath should still be set (frame 0 extraction)
    expect(r.coverPath, 'coverPath should be set even without explicit coverMs').toBeTruthy()
    expect(existsSync(r.coverPath as string)).toBe(true)

    // Validate JPEG magic bytes
    const buf = readFileSync(r.coverPath as string)
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    expect(buf[2]).toBe(0xff)

    // Cleanup
    try { rmSync(outPath) } catch { /* ignore */ }
    try { rmSync(r.coverPath as string) } catch { /* ignore */ }
  })

  // ---------------------------------------------------------------------------
  // Test 5: Main mp4 is NOT affected by coverMs (filter graph identical)
  // ---------------------------------------------------------------------------
  test('(5) @phase-3-27-cover-frame filterGraph identical with and without coverMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const baseOutPath = path.join(os.tmpdir(), 'reels-studio-e2e', `main-graph-plan-${Date.now()}.mp4`)

    // Plan WITHOUT coverMs
    const planWithout = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: baseOutPath }
    )
    expect(planWithout.ok, `buildPlan failed without cover: ${planWithout.error ?? ''}`).toBe(true)
    const fgWithout = planWithout.filterGraph as string

    // Set coverMs
    await page.evaluate((ms) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(ms)
    }, Math.floor(durationMs / 3))

    const baseOutPath2 = path.join(os.tmpdir(), 'reels-studio-e2e', `main-graph-plan2-${Date.now()}.mp4`)

    // Plan WITH coverMs
    const planWith = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: baseOutPath2 }
    )
    expect(planWith.ok, `buildPlan failed with cover: ${planWith.error ?? ''}`).toBe(true)
    const fgWith = planWith.filterGraph as string

    // The main filter graph must be identical — coverMs does NOT affect it
    expect(fgWith, 'filterGraph must be identical regardless of coverMs').toBe(fgWithout)
  })

  // ---------------------------------------------------------------------------
  // Test 6: Undo/redo — one step each
  // ---------------------------------------------------------------------------
  test('(6) @phase-3-27-cover-frame setCoverMs → undo → undefined → redo → restored (one step)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Ensure clean baseline (no cover)
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.clearCoverMs()
    })
    await tick()

    const pastBefore = await getHistoryPastCount()

    // Set coverMs
    const targetMs = Math.floor(durationMs * 0.3)
    await page.evaluate((ms) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(ms)
    }, targetMs)
    await tick()

    const coverAfterSet = await getCoverMs()
    expect(coverAfterSet).not.toBeUndefined()

    const pastAfterSet = await getHistoryPastCount()
    expect(pastAfterSet - pastBefore).toBe(1)

    // Undo
    await doUndo()
    await page.waitForTimeout(200)

    const coverAfterUndo = await getCoverMs()
    expect(coverAfterUndo, 'coverMs should be undefined after undo').toBeUndefined()

    const pastAfterUndo = await getHistoryPastCount()
    expect(pastAfterSet - pastAfterUndo).toBe(1)

    // Redo
    await doRedo()
    await page.waitForTimeout(200)

    const coverAfterRedo = await getCoverMs()
    expect(coverAfterRedo, 'coverMs should be restored after redo').not.toBeUndefined()
    expect(coverAfterRedo!).toBeGreaterThanOrEqual(0)
    expect(coverAfterRedo!).toBeLessThanOrEqual(durationMs)
  })

  // ---------------------------------------------------------------------------
  // Test 7: Clamping — past-end and negative
  // ---------------------------------------------------------------------------
  test('(7) @phase-3-27-cover-frame setCoverMs clamps past-end to totalDuration and negative to 0', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Past end of project
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(99999999)
    })
    await page.waitForTimeout(100)

    const coverPastEnd = await getCoverMs()
    expect(coverPastEnd, 'coverMs past end should be clamped to durationMs').not.toBeUndefined()
    expect(coverPastEnd!).toBeLessThanOrEqual(durationMs + 10) // small rounding tolerance

    // Negative
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(-100)
    })
    await page.waitForTimeout(100)

    const coverNegative = await getCoverMs()
    expect(coverNegative, 'coverMs negative should be clamped to 0').toBe(0)
  })

  // ---------------------------------------------------------------------------
  // Test 8: ExportDialog readout
  // ---------------------------------------------------------------------------
  test('(8) @phase-3-27-cover-frame export-cover-readout shows time when set; "지정 안 함" when unset', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Ensure no cover
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.clearCoverMs()
    })
    await page.waitForTimeout(100)

    // Open ExportDialog — no cover set
    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()

    const readoutNoCover = page.locator('[data-testid="export-cover-readout"]')
    await expect(readoutNoCover).toBeVisible()
    await expect(readoutNoCover).toContainText('지정 안 함')

    // Close dialog, set cover, reopen
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    const coverMs = Math.floor(durationMs * 0.25)
    await page.evaluate((ms) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(ms)
    }, coverMs)
    await page.waitForTimeout(100)

    await page.locator('[data-testid="open-export-dialog"]').click()
    await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible()

    const readoutWithCover = page.locator('[data-testid="export-cover-readout"]')
    await expect(readoutWithCover).toBeVisible()
    // Should NOT show "지정 안 함" when a cover is set
    const text = await readoutWithCover.textContent()
    expect(text).not.toContain('지정 안 함')
    // Should contain the formatted time (some digits / colon pattern)
    expect(text).toMatch(/\d/)
  })

  // ---------------------------------------------------------------------------
  // Test 9: Empty project — setCoverMs must not crash
  // ---------------------------------------------------------------------------
  test('(9) @phase-3-27-cover-frame setCoverMs on empty project (no clips) does not crash', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Verify no clips
    const clipCount = await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      return reels.state().project.tracks.reduce((n, t) => n + t.clips.length, 0)
    })
    expect(clipCount).toBe(0)

    // setCoverMs with a non-zero value on empty project
    // Total duration = 0, so resolveCoverMs returns 0 (clamped)
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setCoverMs(2000)
    })
    await page.waitForTimeout(100)

    // Verify no crash — state is readable
    const coverMs = await getCoverMs()
    // With no clips total duration is 0, so clamped to 0
    expect(coverMs).toBe(0)

    // clearCoverMs also must not crash
    await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.clearCoverMs()
    })
    await page.waitForTimeout(100)

    const coverAfterClear = await getCoverMs()
    expect(coverAfterClear).toBeUndefined()
  })
})
