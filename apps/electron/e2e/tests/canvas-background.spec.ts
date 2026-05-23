/**
 * Phase 3.44 — Canvas Backdrop Fill (canvas background).
 *
 * Contract tested:
 *
 *  FILTER-GRAPH / BYTE-IDENTICAL GATE
 *  (1)  BYTE-IDENTICAL: absent canvasBackground → filterGraph is the baseline
 *       (boxblur=20:1 chain, NOT color=c=black).
 *  (2)  BYTE-IDENTICAL: kind:'blur' → store collapses to absent → same graph
 *       as (1).
 *  (3)  kind:'black' → graph contains `color=c=black:s=` AND not `boxblur=20:1`.
 *  (4)  kind:'white' → graph contains `color=c=white:s=`.
 *  (5)  kind:'color', color:'#ff00ff' → graph contains `color=c=0xff00ff:s=`.
 *  (6)  kind:'color', color:'#000000' → store collapses to {kind:'black'} →
 *       graph contains `color=c=black`, NOT `color=c=0x000000`.
 *  (7)  Invalid color hex → store collapses to absent → graph IDENTICAL to (1).
 *
 *  PREVIEW DOM
 *  (8)  No canvasBackground → preview-video-bg element is a <video>.
 *  (9)  kind:'black' → element is <div> with data-canvas-bg-kind="black" and
 *       computed background ≈ rgb(0,0,0).
 * (10)  kind:'white' → data-canvas-bg-kind="white", background ≈ rgb(255,255,255).
 * (11)  kind:'color', color:'#ff00ff' → data-canvas-bg-kind="color", bg ≈
 *       rgb(255,0,255).
 *
 *  UI
 * (12)  Dropdown picks '검정' → store has {kind:'black'}.
 * (13)  Picking '컬러' → canvas-bg-color input mounts; switching to '검정' → gone.
 *
 *  UNDO/REDO
 * (14)  black → undo → absent → redo → black.
 *
 *  REAL-ENCODE SMOKE
 * (15)  Export with kind:'color', color:'#ff00ff' → ok:true, mp4 > 1 KB.
 *
 * @phase-3-44-canvas-bg
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type mirrors
// ---------------------------------------------------------------------------
type CanvasBackgroundKind = 'black' | 'white' | 'color' | 'blur'

type CanvasBackground = {
  kind: CanvasBackgroundKind
  color?: string
}

type ReelsStore = {
  state: () => {
    project: {
      canvasBackground?: CanvasBackground
      tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }>
      media: Record<string, unknown>
    }
  }
  setCanvasBackground: (bg: CanvasBackground | null) => void
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
test.describe('@phase-3-44-canvas-bg canvas backdrop fill contract', () => {
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
    argvPreview?: string[] | string
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

  async function getCanvasBg(): Promise<CanvasBackground | undefined> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      return reels.state().project.canvasBackground
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

  /** Wait past the zundo throttle window so mutations become distinct undo entries. */
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

  function makeTmpPath(tag: string): string {
    return path.join(os.tmpdir(), 'reels-studio-e2e', `cb-${tag}-${Date.now()}.mp4`)
  }

  // =========================================================================
  // (1) BYTE-IDENTICAL: absent
  //     Fresh project with no canvasBackground → filterGraph contains boxblur=20:1
  //     (the legacy blur chain). This is the gate baseline.
  // =========================================================================
  test('(1) @phase-3-44-canvas-bg BYTE-IDENTICAL: absent canvasBackground → legacy blur chain (boxblur=20:1)', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const baseline = await buildPlan(makeTmpPath('baseline'))
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph, 'baseline filterGraph must be non-empty').toBeTruthy()

    // Gate: legacy chain must be present.
    expect(baselineGraph, 'baseline must contain boxblur=20:1').toContain('boxblur=20:1')
    expect(baselineGraph, 'baseline must NOT contain color=c=black:s=').not.toContain('color=c=black:s=')
    expect(baselineGraph, 'baseline must contain scale=1080:1920').toContain('scale=1080:1920')

    // Confirm store has no canvasBackground field.
    const bg = await getCanvasBg()
    expect(bg, 'fresh project must have no canvasBackground field').toBeUndefined()
  })

  // =========================================================================
  // (2) BYTE-IDENTICAL: kind:'blur'
  //     setCanvasBackground({kind:'blur'}) → store collapses to absent
  //     → filterGraph IDENTICAL to (1).
  // =========================================================================
  test('(2) @phase-3-44-canvas-bg BYTE-IDENTICAL: kind:blur collapses to absent → graph identical to baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const baseline = await buildPlan(makeTmpPath('blur-baseline'))
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Set kind:'blur' — must collapse in store.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'blur'
      })
    })
    await page.waitForTimeout(200)

    // Store must have no field (collapsed to absent).
    const storedBg = await getCanvasBg()
    expect(storedBg, 'kind:blur must collapse to absent in store').toBeUndefined()

    const withBlur = await buildPlan(makeTmpPath('blur-set'))
    expect(withBlur.ok, `blur buildPlan failed: ${withBlur.error ?? ''}`).toBe(true)

    // BYTE-IDENTICAL gate.
    expect(withBlur.filterGraph, 'kind:blur must produce filterGraph identical to baseline').toBe(
      baselineGraph
    )
  })

  // =========================================================================
  // (3) kind:'black' → solid color backdrop (no boxblur)
  //     graph contains `color=c=black:s=` AND does NOT contain `boxblur=20:1`.
  // =========================================================================
  test('(3) @phase-3-44-canvas-bg kind:black → color=c=black:s= in graph; no boxblur=20:1', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Capture baseline first to confirm the swap changes the graph.
    const baseline = await buildPlan(makeTmpPath('black-baseline'))
    expect(baseline.ok).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toContain('boxblur=20:1')

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'black'
      })
    })
    await page.waitForTimeout(200)

    const result = await buildPlan(makeTmpPath('black'))
    expect(result.ok, `black buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    expect(graph, 'black must contain color=c=black:s=').toContain('color=c=black:s=')
    expect(graph, 'black must NOT contain boxblur=20:1').not.toContain('boxblur=20:1')
    // Must differ from baseline.
    expect(graph, 'black must differ from blur baseline').not.toBe(baselineGraph)
  })

  // =========================================================================
  // (4) kind:'white' → color=c=white:s= in graph
  // =========================================================================
  test('(4) @phase-3-44-canvas-bg kind:white → color=c=white:s= in graph; no boxblur=20:1', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'white'
      })
    })
    await page.waitForTimeout(200)

    const result = await buildPlan(makeTmpPath('white'))
    expect(result.ok, `white buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    expect(graph, 'white must contain color=c=white:s=').toContain('color=c=white:s=')
    expect(graph, 'white must NOT contain boxblur=20:1').not.toContain('boxblur=20:1')
  })

  // =========================================================================
  // (5) kind:'color', color:'#ff00ff' → color=c=0xff00ff:s= in graph
  // =========================================================================
  test('(5) @phase-3-44-canvas-bg kind:color #ff00ff → color=c=0xff00ff:s= in graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'color',
        color: '#ff00ff'
      })
    })
    await page.waitForTimeout(200)

    const result = await buildPlan(makeTmpPath('color-magenta'))
    expect(result.ok, `color #ff00ff buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    expect(graph, 'color #ff00ff must contain color=c=0xff00ff:s=').toContain('color=c=0xff00ff:s=')
    expect(graph, 'color #ff00ff must NOT contain boxblur=20:1').not.toContain('boxblur=20:1')
  })

  // =========================================================================
  // (6) kind:'color', color:'#000000' → collapses to {kind:'black'}
  //     → graph contains `color=c=black`, NOT `color=c=0x000000`.
  // =========================================================================
  test('(6) @phase-3-44-canvas-bg kind:color #000000 → collapses to black → graph has color=c=black, not 0x000000', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'color',
        color: '#000000'
      })
    })
    await page.waitForTimeout(200)

    // Store must have collapsed to {kind:'black'}.
    const storedBg = await getCanvasBg()
    expect(storedBg?.kind, 'color:#000000 must collapse to kind:black in store').toBe('black')

    const result = await buildPlan(makeTmpPath('color-black'))
    expect(result.ok, `color #000000 buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''

    expect(graph, 'collapsed black must use color=c=black').toContain('color=c=black')
    expect(graph, 'collapsed black must NOT use color=c=0x000000').not.toContain('color=c=0x000000')
    expect(graph, 'collapsed black must NOT use boxblur=20:1').not.toContain('boxblur=20:1')
  })

  // =========================================================================
  // (7) Invalid color hex → falls back to absent → graph IDENTICAL to (1).
  // =========================================================================
  test('(7) @phase-3-44-canvas-bg invalid hex → collapses to absent → graph identical to blur baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const baseline = await buildPlan(makeTmpPath('invalid-baseline'))
    expect(baseline.ok).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Set an invalid hex — should collapse to absent.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'color',
        color: 'not-a-hex'
      })
    })
    await page.waitForTimeout(200)

    // Store must have no canvasBackground field.
    const storedBg = await getCanvasBg()
    expect(storedBg, 'invalid hex must collapse to absent in store').toBeUndefined()

    const result = await buildPlan(makeTmpPath('invalid-color'))
    expect(result.ok, `invalid-color buildPlan failed: ${result.error ?? ''}`).toBe(true)

    // BYTE-IDENTICAL gate.
    expect(
      result.filterGraph,
      'invalid hex must produce filterGraph identical to absent baseline'
    ).toBe(baselineGraph)
  })

  // =========================================================================
  // (8) Preview DOM: blur → preview-video-bg is a <video>
  // =========================================================================
  test('(8) @phase-3-44-canvas-bg preview DOM: no canvasBackground → preview-video-bg is a <video>', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)
    await page.waitForTimeout(500)

    // Ensure store has no canvasBackground.
    const bg = await getCanvasBg()
    expect(bg, 'fresh project must have no canvasBackground').toBeUndefined()

    const bgEl = page.locator('[data-testid="preview-video-bg"]')
    await expect(bgEl).toBeAttached({ timeout: 5_000 })

    const tagName = await bgEl.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName, 'blur mode preview-video-bg must be a <video> element').toBe('video')
  })

  // =========================================================================
  // (9) Preview DOM: kind:'black' → <div> with data-canvas-bg-kind="black",
  //     computed background ≈ rgb(0,0,0).
  // =========================================================================
  test('(9) @phase-3-44-canvas-bg preview DOM: kind:black → div with data-canvas-bg-kind=black and black bg', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'black'
      })
    })
    await page.waitForTimeout(400)

    const bgEl = page.locator('[data-testid="preview-video-bg"]')
    await expect(bgEl).toBeAttached({ timeout: 5_000 })

    const tagName = await bgEl.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName, 'kind:black preview-video-bg must be a <div>').toBe('div')

    await expect(bgEl).toHaveAttribute('data-canvas-bg-kind', 'black')

    const bgColor = await bgEl.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    )
    // Computed style for #000000 → rgb(0, 0, 0)
    expect(bgColor, 'kind:black computed background must be rgb(0, 0, 0)').toBe('rgb(0, 0, 0)')
  })

  // =========================================================================
  // (10) Preview DOM: kind:'white' → data-canvas-bg-kind="white",
  //      background ≈ rgb(255,255,255).
  // =========================================================================
  test('(10) @phase-3-44-canvas-bg preview DOM: kind:white → div data-canvas-bg-kind=white, white bg', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'white'
      })
    })
    await page.waitForTimeout(400)

    const bgEl = page.locator('[data-testid="preview-video-bg"]')
    await expect(bgEl).toBeAttached({ timeout: 5_000 })

    const tagName = await bgEl.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName, 'kind:white preview-video-bg must be a <div>').toBe('div')

    await expect(bgEl).toHaveAttribute('data-canvas-bg-kind', 'white')

    const bgColor = await bgEl.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    )
    expect(bgColor, 'kind:white computed background must be rgb(255, 255, 255)').toBe(
      'rgb(255, 255, 255)'
    )
  })

  // =========================================================================
  // (11) Preview DOM: kind:'color', color:'#ff00ff' → data-canvas-bg-kind="color",
  //      background ≈ rgb(255,0,255).
  // =========================================================================
  test('(11) @phase-3-44-canvas-bg preview DOM: kind:color #ff00ff → div data-canvas-bg-kind=color, magenta bg', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'color',
        color: '#ff00ff'
      })
    })
    await page.waitForTimeout(400)

    const bgEl = page.locator('[data-testid="preview-video-bg"]')
    await expect(bgEl).toBeAttached({ timeout: 5_000 })

    const tagName = await bgEl.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName, 'kind:color preview-video-bg must be a <div>').toBe('div')

    await expect(bgEl).toHaveAttribute('data-canvas-bg-kind', 'color')

    const bgColor = await bgEl.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    )
    expect(bgColor, 'kind:color #ff00ff computed background must be rgb(255, 0, 255)').toBe(
      'rgb(255, 0, 255)'
    )
  })

  // =========================================================================
  // (12) UI: dropdown changes kind
  //      Select '검정' (value='black') → store has {kind:'black'}.
  // =========================================================================
  test('(12) @phase-3-44-canvas-bg UI: dropdown select black → store has {kind:black}', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)
    await page.waitForTimeout(400)

    const kindSelect = page.locator('[data-testid="canvas-bg-kind"]')
    await expect(kindSelect).toBeVisible({ timeout: 5_000 })

    // Select '검정' — option value is 'black'.
    await kindSelect.selectOption('black')
    await page.waitForTimeout(300)

    const storedBg = await getCanvasBg()
    expect(storedBg?.kind, 'store must have kind:black after dropdown select').toBe('black')
  })

  // =========================================================================
  // (13) UI: color picker mounts only for 'color'
  //      Picking '컬러' → canvas-bg-color in DOM; switching to '검정' → gone.
  // =========================================================================
  test('(13) @phase-3-44-canvas-bg UI: color picker mounts for kind:color; gone for kind:black', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)
    await page.waitForTimeout(400)

    const kindSelect = page.locator('[data-testid="canvas-bg-kind"]')
    await expect(kindSelect).toBeVisible({ timeout: 5_000 })

    const colorPicker = page.locator('[data-testid="canvas-bg-color"]')

    // Initial state: should NOT have the color picker (blur is default).
    await expect(colorPicker, 'color picker must be absent for kind:blur').not.toBeAttached()

    // Switch to '컬러' (value='color').
    await kindSelect.selectOption('color')
    await page.waitForTimeout(300)

    await expect(colorPicker, 'color picker must appear after selecting kind:color').toBeAttached()

    // Switch to '검정' (value='black').
    await kindSelect.selectOption('black')
    await page.waitForTimeout(300)

    await expect(colorPicker, 'color picker must disappear after switching to kind:black').not.toBeAttached()
  })

  // =========================================================================
  // (14) Undo/redo
  //      black → undo → absent → redo → black.
  // =========================================================================
  test('(14) @phase-3-44-canvas-bg undo/redo: black → undo → absent → redo → black', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await page.waitForTimeout(350)

    // Initial state: no canvasBackground.
    const before = await getCanvasBg()
    expect(before, 'fresh project must have no canvasBackground').toBeUndefined()

    const pastBefore = await getHistoryPastCount()

    // Set kind:'black'.
    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'black'
      })
    })
    await tick()

    const afterBlack = await getCanvasBg()
    expect(afterBlack?.kind, 'store must have kind:black').toBe('black')

    const pastAfterBlack = await getHistoryPastCount()
    expect(pastAfterBlack - pastBefore, 'setCanvasBackground must create exactly one undo step').toBe(1)

    // Undo → back to absent.
    await doUndo()

    const afterUndo = await getCanvasBg()
    expect(afterUndo, 'after undo canvasBackground must be absent (undefined)').toBeUndefined()

    // Redo → kind:'black' restored.
    await doRedo()

    const afterRedo = await getCanvasBg()
    expect(afterRedo?.kind, 'after redo canvasBackground must be kind:black again').toBe('black')
  })

  // =========================================================================
  // (15) Real-encode smoke
  //      Export with kind:'color', color:'#ff00ff' → ok:true, mp4 > 1 KB.
  // =========================================================================
  test('(15) @phase-3-44-canvas-bg real-encode smoke: color #ff00ff export → ok:true, mp4 > 1KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    await page.evaluate(() => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setCanvasBackground({
        kind: 'color',
        color: '#ff00ff'
      })
    })
    await page.waitForTimeout(200)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'cb-smoke')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `cb-smoke-${Date.now()}.mp4`)
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
          jobId: `e2e-cb-smoke-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `export with color background failed: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath), `output mp4 must exist at ${outPath}`).toBe(true)
    expect(statSync(outPath).size, 'output mp4 must be > 1 KB').toBeGreaterThan(1024)

    // Cleanup.
    try { rmSync(outPath) } catch { /* ignore */ }
  })
})
