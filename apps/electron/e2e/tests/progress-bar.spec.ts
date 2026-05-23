/**
 * Phase 3.35 — Progress Bar Overlay.
 *
 * Contract:
 *   Project.progressBar?: ProgressBarConfig { enabled, position, color, heightFrac }
 *   getProgressBar(project) → null when absent or disabled (byte-identical gate)
 *   getProjectTotalMs(project) → max endMs across all clips
 *   progressBarToFfmpeg(cfg, totalSec) → drawbox chain string
 *   MIN_PROGRESS_BAR_HEIGHT_FRAC = 0.004
 *   MAX_PROGRESS_BAR_HEIGHT_FRAC = 0.08
 *
 * Export: stitchProgressBar appends a `drawbox` track + a time-varying fill
 *   (`w='iw*min(t,total)/total'`) AFTER captions. Byte-identical when disabled.
 *
 * Renderer: store setProgressBar(patch) / toggleProgressBar() on window.__reelsStore
 *   (one zundo step each). Editor toolbar `toggle-progress-bar` button +
 *   `progress-bar-position` / `progress-bar-color` / `progress-bar-height` controls.
 *   PreviewCanvas `preview-progress-bar-track` + `preview-progress-bar-fill`
 *   (with `data-progress-pct`).
 *
 * @phase-3-35-progress-bar
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants (mirrored from shared/project.ts)
// ---------------------------------------------------------------------------
const MIN_PROGRESS_BAR_HEIGHT_FRAC = 0.004
const MAX_PROGRESS_BAR_HEIGHT_FRAC = 0.08

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ProgressBarPosition = 'top' | 'bottom'

type ProgressBarConfig = {
  enabled: boolean
  position: ProgressBarPosition
  color: string
  heightFrac: number
}

type ReelsStore = {
  state: () => {
    project: {
      progressBar?: ProgressBarConfig
      tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }>
      media: Record<string, unknown>
    }
  }
  setProgressBar: (patch: Partial<ProgressBarConfig>) => void
  toggleProgressBar: () => void
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
test.describe('@phase-3-35-progress-bar progress bar overlay contract', () => {
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
      try {
        await launched.app.close()
      } catch {
        /* ignore */
      }
      launched = null
    }
  })

  // ---------------------------------------------------------------------------
  // Internal helpers
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
    return page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
        const track = reels
          .state()
          .project.tracks.find((t: { kind: string }) => t.kind === 'video')
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

  async function buildPlan(outputPath: string): Promise<{
    ok: boolean
    filterGraph?: string
    argvPreview?: string[]
    error?: string
  }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      async ({ op }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
      },
      { op: outputPath }
    )
  }

  async function getProgressBar(): Promise<ProgressBarConfig | undefined> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      return reels.state().project.progressBar
    })
  }

  async function getHistoryPastCount(): Promise<number> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const t = (window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo
      return t.getState().pastStates.length
    })
  }

  /** Wait past the zundo throttle window (200 ms) so mutations become distinct entries. */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(250)
  }

  async function doUndo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo.getState().undo()
    })
    await launched.page.waitForTimeout(300)
  }

  async function doRedo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: UndoRedo }).__reelsUndoRedo.getState().redo()
    })
    await launched.page.waitForTimeout(300)
  }

  // =========================================================================
  // (1) BYTE-IDENTICAL REGRESSION
  //     a) No progressBar field at all → filterGraph equals baseline; no drawbox,
  //        no [vprog] label.
  //     b) progressBar:{enabled:false,...} → still byte-identical to baseline.
  // =========================================================================
  test('(1) @phase-3-35-progress-bar BYTE-IDENTICAL: absent and disabled progressBar produce the same filterGraph as baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Capture baseline — no progressBar set on a fresh project.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Baseline must not contain progress-bar artefacts.
    expect(baselineGraph).not.toContain('drawbox=')
    expect(baselineGraph).not.toContain('[vprog]')
    // Standard pipeline sanity.
    expect(baselineGraph).toContain('scale=1080:1920')

    // Set progressBar with enabled:false — must stay byte-identical.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: false,
        position: 'bottom',
        color: '#ff0000',
        heightFrac: 0.02
      })
    })
    await page.waitForTimeout(200)

    const disabledPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-disabled-${Date.now()}.mp4`
    )
    const disabledResult = await buildPlan(disabledPath)
    expect(disabledResult.ok, `disabled buildPlan failed: ${disabledResult.error ?? ''}`).toBe(true)
    const disabledGraph = disabledResult.filterGraph ?? ''

    // BYTE-IDENTICAL gate: disabled config must not alter the graph.
    expect(disabledGraph, 'disabled progressBar must produce identical filterGraph to baseline').toBe(
      baselineGraph
    )
    expect(disabledGraph).not.toContain('drawbox=')
    expect(disabledGraph).not.toContain('[vprog]')
  })

  // =========================================================================
  // (2) ENABLED → drawbox in the graph
  //     setProgressBar({enabled:true}) → filterGraph contains drawbox=,
  //     iw*min(t, and [vprog] final label, and argvPreview -map references it.
  // =========================================================================
  test('(2) @phase-3-35-progress-bar enabled progressBar emits drawbox= and [vprog] in the filter graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Enable the progress bar.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-enabled-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    // Must have the track drawbox.
    expect(graph).toContain('drawbox=')
    // Must have the time-varying fill expression.
    expect(graph).toContain('iw*min(t')
    // Final label must be vprog.
    expect(graph).toContain('[vprog]')

    // argvPreview is a space-joined string; must contain "-map [vprog]".
    const argvStr = (result.argvPreview ?? '') as string
    expect(argvStr).toContain('-map [vprog]')
  })

  // =========================================================================
  // (3) POSITION
  //     position:'top'  → graph has y=0
  //     position:'bottom' → graph has y=ih-ih*
  // =========================================================================
  test('(3) @phase-3-35-progress-bar position top → y=0; bottom → y=ih-ih* in filter graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // --- top ---
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'top',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const topPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-top-${Date.now()}.mp4`
    )
    const topResult = await buildPlan(topPath)
    expect(topResult.ok, `top buildPlan failed: ${topResult.error ?? ''}`).toBe(true)
    const topGraph = topResult.filterGraph ?? ''
    // Top position uses y=0.
    expect(topGraph).toContain(':y=0:')

    // --- bottom ---
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const botPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-bottom-${Date.now()}.mp4`
    )
    const botResult = await buildPlan(botPath)
    expect(botResult.ok, `bottom buildPlan failed: ${botResult.error ?? ''}`).toBe(true)
    const botGraph = botResult.filterGraph ?? ''
    // Bottom position uses y=ih-ih* (with the height fraction).
    expect(botGraph).toContain(':y=ih-ih*')
  })

  // =========================================================================
  // (4) COLOR
  //     setProgressBar({color:'#ff0000'}) → graph has color=0xff0000@1.0 (fill)
  //     and 0xff0000@0.25 (track)
  // =========================================================================
  test('(4) @phase-3-35-progress-bar color #ff0000 → 0xff0000@1.0 fill and 0xff0000@0.25 track in graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ff0000',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-color-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    // Fill color at full opacity.
    expect(graph).toContain('color=0xff0000@1.0')
    // Track color at reduced opacity (0.25).
    expect(graph).toContain('color=0xff0000@0.25')
  })

  // =========================================================================
  // (5) HEIGHT FRAC + CLAMPING
  //     setProgressBar({heightFrac:0.05}) → graph h=ih*0.05
  //     Out-of-range 0.5 → clamped to MAX (0.08)
  //     Out-of-range 0.0001 → clamped to MIN (0.004)
  // =========================================================================
  test('(5) @phase-3-35-progress-bar heightFrac=0.05 in graph; out-of-range clamped to MAX/MIN', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // --- In-range: 0.05 ---
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.05
      })
    })
    await page.waitForTimeout(200)

    const inRangePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-hfrac-${Date.now()}.mp4`
    )
    const inRange = await buildPlan(inRangePath)
    expect(inRange.ok, `in-range buildPlan failed: ${inRange.error ?? ''}`).toBe(true)
    const inRangeGraph = inRange.filterGraph ?? ''
    // The height fraction 0.05 must appear in the drawbox h= parameter.
    expect(inRangeGraph).toContain('h=ih*0.05')

    // --- Over MAX: 0.5 → should clamp to MAX_PROGRESS_BAR_HEIGHT_FRAC ---
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.5
      })
    })
    await page.waitForTimeout(200)

    const maxPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-clamp-max-${Date.now()}.mp4`
    )
    const maxResult = await buildPlan(maxPath)
    expect(maxResult.ok, `MAX-clamp buildPlan failed: ${maxResult.error ?? ''}`).toBe(true)
    const maxGraph = maxResult.filterGraph ?? ''
    // The effective heightFrac must be MAX (0.08), not 0.5.
    expect(maxGraph).toContain(`h=ih*${MAX_PROGRESS_BAR_HEIGHT_FRAC}`)
    expect(maxGraph).not.toContain('h=ih*0.5')

    // --- Under MIN: 0.0001 → should clamp to MIN_PROGRESS_BAR_HEIGHT_FRAC ---
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.0001
      })
    })
    await page.waitForTimeout(200)

    const minPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-clamp-min-${Date.now()}.mp4`
    )
    const minResult = await buildPlan(minPath)
    expect(minResult.ok, `MIN-clamp buildPlan failed: ${minResult.error ?? ''}`).toBe(true)
    const minGraph = minResult.filterGraph ?? ''
    // The effective heightFrac must be MIN (0.004), not 0.0001.
    expect(minGraph).toContain(`h=ih*${MIN_PROGRESS_BAR_HEIGHT_FRAC}`)
    expect(minGraph).not.toContain('h=ih*0.0001')
  })

  // =========================================================================
  // (6) PREVIEW BAR FILLS
  //     Enable the bar; set playhead to ~0% / ~50% / ~100% of project duration
  //     → preview-progress-bar-fill data-progress-pct ≈ 0 / 50 / 100
  //     preview-progress-bar-track positioned top vs bottom per config
  // =========================================================================
  test('(6) @phase-3-35-progress-bar preview fill data-progress-pct reflects playhead 0/50/100% of timeline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Enable the bar at bottom.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(300)

    const track = page.locator('[data-testid="preview-progress-bar-track"]')
    const fill = page.locator('[data-testid="preview-progress-bar-fill"]')

    // The track must be visible (it has non-zero width=100% always).
    await expect(track).toBeVisible({ timeout: 5_000 })

    // The fill element is present in the DOM even at 0% (but its width=0 makes
    // Playwright see it as invisible). Check data-progress-pct by attribute
    // query rather than requiring visibility.
    await expect(fill).toBeAttached({ timeout: 5_000 })

    // Helper: set playhead and read data-progress-pct.
    async function pctAt(ms: number): Promise<number> {
      await page.evaluate((playheadMs: number) => {
        window.__reelsTimelineUi.getState().setPlayheadMs(playheadMs)
      }, ms)
      await page.waitForTimeout(200)
      const attr = await fill.getAttribute('data-progress-pct')
      return parseFloat(attr ?? '0')
    }

    // ~0% — fill has width:0% → element is in DOM but collapsed.
    const pct0 = await pctAt(0)
    expect(pct0).toBeCloseTo(0, 0) // within ±0.5

    // ~50% — playhead at half the duration.
    const pct50 = await pctAt(Math.round(durationMs / 2))
    expect(pct50).toBeGreaterThan(40)
    expect(pct50).toBeLessThan(60)

    // ~100% (at or past the end).
    const pct100 = await pctAt(durationMs)
    expect(pct100).toBeCloseTo(100, 0) // within ±0.5

    // Verify bottom positioning: track should have bottom:0 style (not top:0).
    // The track uses position:'bottom' when cfg.position === 'bottom'.
    const trackBottom = await track.evaluate((el) => (el as HTMLElement).style.bottom)
    const trackTop = await track.evaluate((el) => (el as HTMLElement).style.top)
    // bottom config → style.bottom is '0' or '0px', top is empty.
    const isBottomPositioned = trackBottom === '0' || trackBottom === '0px' || trackTop === ''
    expect(
      isBottomPositioned,
      `expected track to be positioned at bottom, but bottom='${trackBottom}' top='${trackTop}'`
    ).toBe(true)

    // Now switch to top and verify the track moves.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'top',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(300)

    await expect(track).toBeVisible({ timeout: 3_000 })
    const trackTopAfterSwitch = await track.evaluate((el) => (el as HTMLElement).style.top)
    // top config → style.top is '0' (or '0px').
    const isTopPositioned = trackTopAfterSwitch === '0' || trackTopAfterSwitch === '0px'
    expect(
      isTopPositioned,
      `expected track to be at top after switching, but top='${trackTopAfterSwitch}'`
    ).toBe(true)
  })

  // =========================================================================
  // (7) UNDO/REDO
  //     toggleProgressBar on → enabled===true → undo → reverts → redo → restored
  //     One step per call.
  // =========================================================================
  test('(7) @phase-3-35-progress-bar toggleProgressBar → undo reverts → redo restores (one step)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Allow editor mount to settle.
    await page.waitForTimeout(350)

    // Confirm progress bar is off initially.
    const pbBefore = await getProgressBar()
    const enabledBefore = pbBefore?.enabled ?? false
    expect(enabledBefore).toBe(false)

    const pastBefore = await getHistoryPastCount()

    // Toggle ON.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.toggleProgressBar()
    })
    await tick()

    const pbOn = await getProgressBar()
    expect(pbOn?.enabled, 'progress bar should be enabled after toggle').toBe(true)

    const pastAfterToggle = await getHistoryPastCount()
    expect(pastAfterToggle - pastBefore, 'toggle should add exactly one undo step').toBe(1)

    // Undo → off.
    await doUndo()

    const pbAfterUndo = await getProgressBar()
    const enabledAfterUndo = pbAfterUndo?.enabled ?? false
    expect(enabledAfterUndo, 'undo should revert toggle (progress bar disabled)').toBe(false)

    const pastAfterUndo = await getHistoryPastCount()
    expect(pastAfterToggle - pastAfterUndo, 'undo consumed exactly one step').toBe(1)

    // Redo → on again.
    await doRedo()

    const pbAfterRedo = await getProgressBar()
    expect(pbAfterRedo?.enabled, 'redo should restore toggle (progress bar enabled)').toBe(true)
  })

  // =========================================================================
  // (7b) UNDO/REDO — setProgressBar patch (color/heightFrac) also one step.
  // =========================================================================
  test('(7b) @phase-3-35-progress-bar setProgressBar patch → undo/redo round-trip (one step)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.waitForTimeout(350)

    // Turn on the bar first.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await tick()

    // Now change the color (one more step).
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        color: '#00ff00'
      })
    })
    await tick()

    const pbAfterColor = await getProgressBar()
    expect(pbAfterColor?.color).toBe('#00ff00')

    // Undo color change.
    await doUndo()
    const pbAfterUndo = await getProgressBar()
    // Color should revert (was '#ffffff' before the patch, or at least not '#00ff00').
    expect(pbAfterUndo?.color).not.toBe('#00ff00')

    // Redo color change.
    await doRedo()
    const pbAfterRedo = await getProgressBar()
    expect(pbAfterRedo?.color).toBe('#00ff00')
  })

  // =========================================================================
  // (8) UI — toolbar toggle and controls
  //     toggle-progress-bar button toggles; when on, progress-bar-position,
  //     progress-bar-color, progress-bar-height controls appear and call setProgressBar.
  // =========================================================================
  test('(8) @phase-3-35-progress-bar UI: toggle-progress-bar button toggles; controls visible when on', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Phase 3.45+: progress-bar controls live inside the 옵션▾ popover.
    await page.click('[data-testid="topbar-menu-options"]')
    await page.locator('[data-testid="topbar-menu-options-popover"]').waitFor({ state: 'visible' })

    // The toggle button must be present.
    const toggleBtn = page.locator('[data-testid="toggle-progress-bar"]')
    await expect(toggleBtn).toBeVisible({ timeout: 5_000 })

    // When off, aria-pressed should be 'false'.
    const pressedBefore = await toggleBtn.getAttribute('aria-pressed')
    expect(pressedBefore).toBe('false')

    // Controls should be absent (or hidden) while disabled.
    // We don't hard-fail on this since the implementation may use display:none.
    // The important invariant is that after toggle they appear.

    // Click the toggle to enable.
    await toggleBtn.click()
    await page.waitForTimeout(300)

    // aria-pressed should flip to 'true'.
    await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 })

    // Controls must appear.
    const positionControl = page.locator('[data-testid="progress-bar-position"]')
    const colorControl = page.locator('[data-testid="progress-bar-color"]')
    const heightControl = page.locator('[data-testid="progress-bar-height"]')

    await expect(positionControl).toBeVisible({ timeout: 5_000 })
    await expect(colorControl).toBeVisible({ timeout: 3_000 })
    await expect(heightControl).toBeVisible({ timeout: 3_000 })

    // Verify that changing the position select updates the store.
    // Select 'top' option (value='top').
    await positionControl.selectOption('top')
    await page.waitForTimeout(200)
    const pbAfterTop = await getProgressBar()
    expect(pbAfterTop?.position).toBe('top')

    // Select 'bottom' option.
    await positionControl.selectOption('bottom')
    await page.waitForTimeout(200)
    const pbAfterBottom = await getProgressBar()
    expect(pbAfterBottom?.position).toBe('bottom')

    // Click the toggle again to disable.
    await toggleBtn.click()
    await page.waitForTimeout(300)
    await expect(toggleBtn).toHaveAttribute('aria-pressed', 'false', { timeout: 3_000 })

    // Progress bar should be disabled in the store.
    const pbAfterOff = await getProgressBar()
    expect(pbAfterOff?.enabled ?? false).toBe(false)

    // No critical page errors during UI interaction.
    const criticalErrors = launched.pageErrors.filter(
      (e) => !/supabase|auth|fetch|network/i.test(e.message)
    )
    expect(criticalErrors).toHaveLength(0)
  })

  // =========================================================================
  // (9) REAL-ENCODE SMOKE (recommended)
  //     exporter:run with progress bar enabled → completes without ffmpeg error,
  //     output mp4 > 1 KB.
  // =========================================================================
  test('(9) @phase-3-35-progress-bar real-encode smoke: export with progress bar enabled produces valid mp4 > 1KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Enable the progress bar.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'pb-smoke')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `pb-smoke-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore */
      }
    }

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-pb-smoke-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `export with progress bar failed: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath), `output mp4 must exist at ${outPath}`).toBe(true)
    expect(statSync(outPath).size, 'output mp4 must be > 1 KB').toBeGreaterThan(1024)

    // Cleanup.
    try {
      rmSync(outPath)
    } catch {
      /* ignore */
    }
  })

  // =========================================================================
  // BONUS: toggle OFF after ON → buildPlan reverts to byte-identical baseline.
  //        This guards the round-trip: on→off produces the same graph as the
  //        initial off state.
  // =========================================================================
  test('(bonus) @phase-3-35-progress-bar toggle off after on → filterGraph reverts to baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Capture baseline.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-roundtrip-base-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''

    // Enable.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: true,
        position: 'bottom',
        color: '#ffffff',
        heightFrac: 0.012
      })
    })
    await page.waitForTimeout(200)

    const enabledPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-roundtrip-on-${Date.now()}.mp4`
    )
    const enabledResult = await buildPlan(enabledPath)
    expect(enabledResult.ok).toBe(true)
    // Must differ from baseline when enabled.
    expect(enabledResult.filterGraph).not.toBe(baselineGraph)
    expect(enabledResult.filterGraph).toContain('drawbox=')

    // Disable (toggle off).
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setProgressBar({
        enabled: false
      })
    })
    await page.waitForTimeout(200)

    const disabledPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `pb-roundtrip-off-${Date.now()}.mp4`
    )
    const disabledResult = await buildPlan(disabledPath)
    expect(disabledResult.ok).toBe(true)
    // Must revert to baseline graph (byte-identical).
    expect(disabledResult.filterGraph, 'disabled after enabled must equal baseline').toBe(
      baselineGraph
    )
    expect(disabledResult.filterGraph).not.toContain('drawbox=')
    expect(disabledResult.filterGraph).not.toContain('[vprog]')
  })
})
