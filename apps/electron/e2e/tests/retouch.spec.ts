/**
 * @phase-retouch — per-clip retouch/beauty toggle + export filter.
 *
 * Covers all 10 contracted scenarios from the TEST brief:
 *
 * UI:
 *   (1) effects-section-retouch appears in the EffectsPanel for a media video
 *       clip; retouch-toggle + slider controls are present.
 *   (2) Toggle ON → clip.retouch === DEFAULT_RETOUCH (40); OFF → undefined.
 *   (3) setClipRetouch(id, 100) → 100; setClipRetouch(id, 25) → 25;
 *       slider/input are disabled while retouch is off.
 *
 * Export graph:
 *   (4) clip with retouch=50 → filterGraph contains smartblur=lr=1.750:ls=0.525:lt=16,
 *       positioned AFTER color-grading (eq/hue/curves/huesaturation) and
 *       BEFORE fps= in that clip's video fragment.
 *   (5) BYTE-IDENTICAL REGRESSION — clip with retouch absent → no smartblur;
 *       clip with retouch=0 → no smartblur. Uses not.toContain('smartblur')
 *       (boxblur from the blurred-bg base layer is unaffected).
 *
 * Formula unit (via buildPlan + known inputs):
 *   (6) retouch=1 → smartblur=lr=1.015:ls=0.304:lt=8;
 *       retouch=50 → lr=1.750:ls=0.525:lt=16;
 *       retouch=100 → lr=2.500:ls=0.750:lt=24;
 *       retouch=0/absent → no smartblur.
 *
 * Clamping:
 *   (7) setClipRetouch(id, 999) → stored 100;
 *       setClipRetouch(id, -5) → undefined (off);
 *       setClipRetouch(id, NaN) → no-op (unchanged).
 *
 * Undo/redo:
 *   (8) toggle on (retouch=40) → undo → undefined → redo → 40.
 *
 * Mixed timeline:
 *   (9) two clips, one retouch-on / one off → exactly one smartblur= in graph.
 *
 * Real-encode smoke:
 *   (10) exporter:run on a clip with retouch=60 completes without ffmpeg error;
 *        output mp4 > 1KB.
 */

import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type declarations for window test bridges
// ---------------------------------------------------------------------------
type ProjectStoreState = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      role?: string
      clips: Array<Record<string, unknown>>
    }>
    media: Record<string, unknown>
  }
  setClipRetouch: (clipId: string, strength: number) => void
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStoreState
      temporal: {
        getState: () => {
          undo: () => void
          redo: () => void
          pastStates: unknown[]
          futureStates: unknown[]
        }
      }
    }
    __reelsStore: {
      state: () => ProjectStoreState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
    __reelsTimelineUi: {
      getState: () => {
        setPlayheadMs: (ms: number) => void
        selectClip: (id: string) => void
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-retouch retouch/beauty toggle + export filter', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
      await new Promise((r) => setTimeout(r, 900))
    })
  })

  test.afterEach(async () => {
    if (launched) {
      const userDataDir = (launched as unknown as { userDataDir?: string }).userDataDir
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      if (userDataDir) {
        try {
          const fs = await import('node:fs')
          fs.rmSync(userDataDir, { recursive: true, force: true })
        } catch {
          /* best-effort */
        }
      }
      launched = null
    }
  })

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
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
    return page.evaluate(async (filePath: string) => {
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
  }

  async function addVideoClip(
    mediaId: string,
    durationMs: number,
    startMs = 0
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
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

  async function getClipFromState(clipId: string): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks) {
        for (const c of t.clips) {
          if ((c as Record<string, unknown>).id === cid) return c
        }
      }
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  /**
   * Select a clip in the timeline DOM so the EffectsPanel tracks the selection.
   */
  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const block = page.locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`).first()
    const count = await block.count()
    if (count > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
      return
    }
    // Fallback via timeline-ui store.
    await page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await page.waitForTimeout(150)
  }

  /**
   * Open the EffectsPanel for a selected clip, then navigate to the 조정 (adjust)
   * tab where the retouch section lives.
   */
  async function openEffectsPanelAdjust(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await selectClip(clipId)
    const toggleBtn = page.locator('[data-testid="toggle-effects-panel"]')
    // Open if not already open.
    const panelCount = await page.locator('[data-testid="effects-panel"]').count()
    if (panelCount === 0) {
      await toggleBtn.click()
      await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({ timeout: 5_000 })
    }
    // Navigate to the 조정 tab (contains retouch section).
    const adjustTab = page.locator('[data-testid="effects-tab-adjust"]')
    const adjustTabCount = await adjustTab.count()
    if (adjustTabCount > 0) {
      const pressed = await adjustTab.getAttribute('aria-pressed')
      if (pressed !== 'true') {
        await adjustTab.click()
        await page.waitForTimeout(150)
      }
    }
    await expect(page.locator('[data-testid="effects-section-retouch"]')).toBeVisible({ timeout: 5_000 })
    // Phase 3.47 — sections are accordion; retouch is collapsed by default.
    // Click the section header to expand the body so retouch-toggle/slider mount.
    const retouchToggle = page.locator('[data-testid="section-toggle-retouch"]')
    if ((await retouchToggle.count()) > 0) {
      const expanded = await retouchToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        await retouchToggle.click()
        await page.waitForTimeout(120)
      }
    }
  }

  /** Sleep >= undo throttle window (220ms). */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().undo()
    })
  }

  async function redo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().redo()
    })
  }

  // =========================================================================
  // (1) UI present — effects-section-retouch appears for a media video clip
  // =========================================================================
  test('(1) effects-section-retouch visible for media clip; retouch-toggle + slider present', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid)

    const section = page.locator('[data-testid="effects-section-retouch"]')
    await expect(section).toBeVisible()

    // Retouch toggle must exist.
    await expect(page.locator('[data-testid="retouch-toggle"]')).toBeVisible()

    // Slider and number input must exist.
    await expect(page.locator('[data-testid="effects-retouch-slider"]')).toBeAttached()
    await expect(page.locator('[data-testid="effects-retouch-input"]')).toBeAttached()
  })

  // =========================================================================
  // (2) Toggle on → clip.retouch === 40 (DEFAULT_RETOUCH); off → undefined
  // =========================================================================
  test('(2) retouch-toggle ON → clip.retouch=40 (DEFAULT_RETOUCH); OFF → undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid)

    // Initially toggle is unchecked; clip.retouch is absent.
    const toggle = page.locator('[data-testid="retouch-toggle"]')
    await expect(toggle).not.toBeChecked()
    const before = await getClipFromState(cid)
    expect(before?.retouch).toBeUndefined()

    // Click toggle ON via evaluate to handle viewport overflow.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="retouch-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(120)

    // clip.retouch must be DEFAULT_RETOUCH = 40.
    const clipOn = await getClipFromState(cid)
    expect(clipOn?.retouch).toBe(40)

    // Toggle must now be checked.
    await expect(toggle).toBeChecked()

    // Click toggle OFF.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="retouch-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(120)

    const clipOff = await getClipFromState(cid)
    expect(clipOff?.retouch).toBeUndefined()
    await expect(toggle).not.toBeChecked()
  })

  // =========================================================================
  // (3) Slider: disabled while off; setClipRetouch(id, 100) → 100; 25 → 25
  // =========================================================================
  test('(3) slider disabled when off; setClipRetouch(id,100)→100; setClipRetouch(id,25)→25', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid)

    // Slider and number input must be disabled while retouch is off.
    const slider = page.locator('[data-testid="effects-retouch-slider"]')
    const numInput = page.locator('[data-testid="effects-retouch-input"]')
    await expect(slider).toBeDisabled()
    await expect(numInput).toBeDisabled()

    // Turn retouch ON to value 100 directly via store.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 100)
    }, cid)
    await page.waitForTimeout(80)

    const clipAt100 = await getClipFromState(cid)
    expect(clipAt100?.retouch).toBe(100)

    // After turning on, controls must be enabled.
    await expect(slider).toBeEnabled({ timeout: 3_000 })
    await expect(numInput).toBeEnabled({ timeout: 3_000 })

    // Set to 25 → updates.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 25)
    }, cid)
    await page.waitForTimeout(80)

    const clipAt25 = await getClipFromState(cid)
    expect(clipAt25?.retouch).toBe(25)
  })

  // =========================================================================
  // (4) Export: retouch=50 → smartblur=lr=1.750:ls=0.525:lt=16 in filter graph,
  //     AFTER color grading, BEFORE fps=
  // =========================================================================
  test('(4) buildPlan with retouch=50 → smartblur=lr=1.750:ls=0.525:lt=16 after color grading, before fps=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Set retouch=50 via store.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 50)
    }, cid)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `retouch-plan-50-${Date.now()}.mp4`)

    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )

    expect(result.ok).toBe(true)
    expect(result.filterGraph).toBeTruthy()

    const graph: string = result.filterGraph ?? ''

    // Must contain the expected smartblur string.
    expect(graph).toContain('smartblur=lr=1.750:ls=0.525:lt=16')

    // Position check: smartblur must come AFTER any color grading filters and
    // BEFORE fps= in the same video fragment. Fragments are separated by ";".
    const fragments = graph.split(';')
    const retouchFrag = fragments.find((f) => f.includes('smartblur=lr=1.750:ls=0.525:lt=16'))
    expect(retouchFrag).toBeTruthy()

    if (retouchFrag) {
      const smartblurPos = retouchFrag.indexOf('smartblur=lr=1.750:ls=0.525:lt=16')
      const fpsPos = retouchFrag.indexOf('fps=')

      // smartblur must appear BEFORE fps= in the fragment.
      if (fpsPos !== -1) {
        expect(smartblurPos).toBeLessThan(fpsPos)
      }

      // If any color-grading filter is present, smartblur must come AFTER it.
      for (const colorFilter of ['eq=', 'hue=', 'curves=', 'huesaturation=', 'colortemperature=']) {
        const colorPos = retouchFrag.lastIndexOf(colorFilter)
        if (colorPos !== -1) {
          expect(smartblurPos).toBeGreaterThan(colorPos)
        }
      }
    }
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL REGRESSION — retouch absent → no smartblur; retouch=0 → no smartblur
  // =========================================================================
  test('(5) REGRESSION: clip with retouch absent → no smartblur; retouch=0 → no smartblur', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Clip A: retouch absent (never set).
    await addVideoClip(mediaId, durationMs, 0)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `retouch-baseline-${Date.now()}.mp4`)

    const resultAbsent = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )

    expect(resultAbsent.ok).toBe(true)
    const graphAbsent: string = resultAbsent.filterGraph ?? ''

    // smartblur must be completely absent (base-layer boxblur is unaffected).
    expect(graphAbsent).not.toContain('smartblur')

    // Now add a second clip with retouch explicitly set to 0 — must also produce no smartblur.
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 0)
    }, cid2)
    await page.waitForTimeout(80)

    // Verify store collapsed to undefined.
    const clip2 = await getClipFromState(cid2)
    expect(clip2?.retouch).toBeUndefined()

    const outPath2 = path.join(os.tmpdir(), 'reels-studio-e2e', `retouch-zero-${Date.now()}.mp4`)
    const resultZero = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath2 }
    )

    expect(resultZero.ok).toBe(true)
    const graphZero: string = resultZero.filterGraph ?? ''
    expect(graphZero).not.toContain('smartblur')
  })

  // =========================================================================
  // (6) Formula unit — via buildPlan with known inputs
  //     retouch=1 → lr=1.015:ls=0.305:lt=8
  //     retouch=50 → lr=1.750:ls=0.525:lt=16
  //     retouch=100 → lr=2.500:ls=0.750:lt=24
  //     retouch=0/absent → no smartblur
  // =========================================================================
  test('(6) formula: retouch 1→lr=1.015:ls=0.305:lt=8; 50→lr=1.750:ls=0.525:lt=16; 100→lr=2.500:ls=0.750:lt=24; 0→no smartblur', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Helper: add clip at a unique startMs, set retouch, get the filter graph.
    async function getGraphForStrength(strength: number, slotIndex: number): Promise<string> {
      const startMs = slotIndex * (durationMs + 1000)
      const cid = await addVideoClip(mediaId, durationMs, startMs)
      await page.evaluate(
        ({ id, s }) => {
          window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, s)
        },
        { id: cid, s: strength }
      )
      const outPath = path.join(
        os.tmpdir(),
        'reels-studio-e2e',
        `retouch-formula-${strength}-${Date.now()}.mp4`
      )
      const r = await page.evaluate(
        async ({ outputPath }) => {
          const reels = window.__reelsStore
          const project = reels.state().project
          return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
        },
        { outputPath: outPath }
      )
      return (r.filterGraph ?? '') as string
    }

    // Strength 1 → lr=1.015, ls=0.304, lt=8.
    // Note: (0.3 + 0.45 * 0.01).toFixed(3) = "0.304" (JS float arithmetic).
    const graph1 = await getGraphForStrength(1, 0)
    expect(graph1).toContain('smartblur=lr=1.015:ls=0.304:lt=8')

    // Strength 50 → lr=1.750, ls=0.525, lt=16.
    const graph50 = await getGraphForStrength(50, 1)
    expect(graph50).toContain('smartblur=lr=1.750:ls=0.525:lt=16')

    // Strength 100 → lr=2.500, ls=0.750, lt=24.
    const graph100 = await getGraphForStrength(100, 2)
    expect(graph100).toContain('smartblur=lr=2.500:ls=0.750:lt=24')

    // Strength 0 → setClipRetouch stores undefined → no smartblur from that clip.
    // Add the off-clip at its own slot.
    const startMsOff = 3 * (durationMs + 1000)
    const cidOff = await addVideoClip(mediaId, durationMs, startMsOff)
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 0)
    }, cidOff)
    await page.waitForTimeout(80)

    const offClip = await getClipFromState(cidOff)
    // setClipRetouch(id, 0) stores undefined.
    expect(offClip?.retouch).toBeUndefined()

    // Verify the specific fragment for cidOff has no smartblur.
    const outPathOff = path.join(os.tmpdir(), 'reels-studio-e2e', `retouch-formula-0-${Date.now()}.mp4`)
    const rOff = await page.evaluate(
      async ({ outputPath, cid }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        const plan = await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
        const fragments = (plan.filterGraph ?? '').split(';')
        const clipSuffix = cid.slice(-6)
        const clipFrag = fragments.find((f) => f.includes(`_${clipSuffix}`) || f.includes(cid)) ?? null
        return { clipFrag: clipFrag ?? null }
      },
      { outputPath: outPathOff, cid: cidOff }
    )
    if (rOff.clipFrag) {
      expect(rOff.clipFrag).not.toContain('smartblur')
    }
  })

  // =========================================================================
  // (7) Clamping: 999 → 100; -5 → undefined; NaN → no-op
  // =========================================================================
  test('(7) clamping: setClipRetouch(999)→100; setClipRetouch(-5)→undefined; setClipRetouch(NaN)→no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Set to over-max (999) → clamped to 100.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 999)
    }, cid)
    await page.waitForTimeout(80)
    const clipAt999 = await getClipFromState(cid)
    expect(clipAt999?.retouch).toBe(100)

    // Set to below-zero (-5) → treated as 0 → stored as undefined.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, -5)
    }, cid)
    await page.waitForTimeout(80)
    const clipAtMinus5 = await getClipFromState(cid)
    expect(clipAtMinus5?.retouch).toBeUndefined()

    // Set to a known value first so we can verify NaN is a no-op.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 60)
    }, cid)
    await page.waitForTimeout(80)
    const clipAt60 = await getClipFromState(cid)
    expect(clipAt60?.retouch).toBe(60)

    // Set NaN → must be a no-op (value stays at 60).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, NaN)
    }, cid)
    await page.waitForTimeout(80)
    const clipAfterNaN = await getClipFromState(cid)
    expect(clipAfterNaN?.retouch).toBe(60)
  })

  // =========================================================================
  // (8) Undo/redo: toggle on (retouch=40) → undo → undefined → redo → 40
  // =========================================================================
  test('(8) undo/redo: toggle retouch on → undo → undefined → redo → 40', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    // Confirm fresh clip has no retouch.
    const fresh = await getClipFromState(cid)
    expect(fresh?.retouch).toBeUndefined()

    // Toggle retouch ON at DEFAULT_RETOUCH=40.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 40)
    }, cid)
    await tick()

    const withRetouch = await getClipFromState(cid)
    expect(withRetouch?.retouch).toBe(40)

    // Undo → retouch should be undefined.
    await undo()
    await page.waitForTimeout(100)
    const afterUndo = await getClipFromState(cid)
    expect(afterUndo?.retouch).toBeUndefined()

    // Redo → retouch should be 40 again.
    await redo()
    await page.waitForTimeout(100)
    const afterRedo = await getClipFromState(cid)
    expect(afterRedo?.retouch).toBe(40)
  })

  // =========================================================================
  // (9) Mixed timeline: two clips, one retouch-on / one off →
  //     exactly one smartblur= in graph
  // =========================================================================
  test('(9) mixed timeline: retouch-on clip has smartblur; retouch-off clip does not; exactly one smartblur', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add two clips back-to-back.
    const cid1 = await addVideoClip(mediaId, durationMs, 0)
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)

    // Only cid1 has retouch on (strength=75).
    // retouch=75: t=0.75, lr=2.125, ls=0.637 (JS float), lt=20.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 75)
    }, cid1)

    // cid2 stays off.
    const clip2 = await getClipFromState(cid2)
    expect(clip2?.retouch).toBeUndefined()

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `retouch-mixed-${Date.now()}.mp4`)
    const result = await page.evaluate(
      async ({ outputPath, id1, id2 }) => {
        const project = window.__reelsStore.state().project
        const plan = await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
        const fragments = (plan.filterGraph ?? '').split(';')
        // Find the video pre-chain fragment for each clip by index (pre0, pre1, etc.)
        // The video pre-chain fragment for clip N is the one labeled [preN] at its end,
        // or contains "setpts=PTS-STARTPTS" (video only, not audio which uses asetpts).
        const videoFrags = fragments.filter(
          (f) => f.includes('setpts=PTS-STARTPTS') && !f.includes('asetpts')
        )
        const frag1 = videoFrags[0] ?? null
        const frag2 = videoFrags[1] ?? null
        return {
          ok: plan.ok,
          fullGraph: plan.filterGraph ?? '',
          frag1,
          frag2
        }
      },
      { outputPath: outPath, id1: cid1, id2: cid2 }
    )

    expect(result.ok).toBe(true)

    // Full graph must contain smartblur (from cid1).
    expect(result.fullGraph).toContain('smartblur')

    // Verify the exact smartblur string for strength=75.
    // t=0.75 → lr=2.125, ls=0.637 (JS: (0.3+0.45*0.75).toFixed(3)="0.637"), lt=20.
    expect(result.fullGraph).toContain('smartblur=lr=2.125:ls=0.637:lt=20')

    // cid1 fragment should contain smartblur.
    if (result.frag1) {
      expect(result.frag1).toContain('smartblur')
    }

    // cid2 fragment must NOT contain smartblur.
    if (result.frag2) {
      expect(result.frag2).not.toContain('smartblur')
    }

    // Exactly one smartblur= in the whole graph.
    const smartblurCount = (result.fullGraph.match(/smartblur=/g) ?? []).length
    expect(smartblurCount).toBe(1)
  })

  // =========================================================================
  // (10) Real-encode smoke: exporter:run on a clip with retouch=60 → ok=true,
  //      output mp4 > 1KB.
  // =========================================================================
  test('(10) real-encode smoke: retouch=60 → exporter:run completes, output mp4 > 1KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Set retouch=60.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 60)
    }, cid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `retouch-smoke-${Date.now()}.mp4`)

    // Allow the output path.
    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-retouch-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath },
    )

    // The smoke test verifies that smartblur does not crash ffmpeg.
    expect(r.ok, `expected retouch export to succeed, error: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  })
})
