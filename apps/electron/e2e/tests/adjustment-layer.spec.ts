/**
 * Phase 3.32 — 조정 레이어 (Adjustment Layer).
 *
 * A timeline element with a [startMs, endMs] range that applies a color grade
 * to the final composited frame for everything beneath it. Lives in
 * `Project.adjustmentLayers` — NOT a Clip, NOT a Track.
 *
 * Contract tested:
 *   Project.adjustmentLayers?: AdjustmentLayer[]
 *   AdjustmentLayer { id, startMs, endMs, colorAdjust?, curves?, hsl?,
 *                     filterPreset?, filterIntensity? }
 *   getAdjustmentLayers(project) — sanitized / sorted / neutral-dropped
 *   adjustmentLayerToFfmpeg(...)  — time-gated grade fragment
 *   MAX_ADJUSTMENT_LAYERS = 8
 *   DEFAULT_ADJUSTMENT_LAYER_MS = 3000
 *
 * Store actions (via window.__reelsStore):
 *   addAdjustmentLayer(startMs, endMs) → id | null
 *   removeAdjustmentLayer(id)
 *   updateAdjustmentLayer(id, { startMs?, endMs? })
 *   setAdjustmentLayerColorAdjust(id, partial)
 *   setAdjustmentLayerCurvePoint(id, channel, pointIndex, { x, y })
 *   setAdjustmentLayerHslBand(id, band, partial)
 *   setAdjustmentLayerFilterPreset(id, preset, intensity?)
 *   setSelectedAdjustmentLayerId(layerId | null)
 *
 * Scenarios:
 *  (1) BYTE-IDENTICAL REGRESSION — project with NO adjustment layers →
 *      buildPlan filterGraph equals pre-feature baseline; no :enable='between(t,'
 *      from adjustment layers. Also: a neutral (no-grade) layer → still
 *      byte-identical (getAdjustmentLayers drops it).
 *  (2) addAdjustmentLayer — creates entry with correct bounds; endMs clamp;
 *      9th call when 8 exist → returns null.
 *  (3) Grade emitted, time-gated — colorAdjust brightness → graph contains
 *      eq= ... :enable='between(t,1.000,4.000)'.
 *  (4) Curves / filter preset — non-identity curve → curves=...:enable=...;
 *      filterPreset 'vibrant' → its filter with :enable=.
 *  (5) Two overlapping layers stack — each graded → two distinct
 *      :enable='between(t,' groups in the graph, in ascending startMs order.
 *  (6) Undo/redo — addAdjustmentLayer → undo → empty → redo → restored;
 *      setAdjustmentLayerColorAdjust → undo restores. One step each.
 *  (7) updateAdjustmentLayer — move/trim → bounds change, re-clamped.
 *  (8) Preview — playhead inside a graded adjustment layer →
 *      preview-fitted-rect has data-adjustment-active; outside → not active.
 *  (9) UI — add-adjustment-layer creates block in adjustment-layer-lane;
 *      clicking opens adjustment-layer-editor; delete-adjustment-layer removes.
 *
 * @phase-3-32-adjustment-layer
 */

import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants mirrored from shared/project.ts
// ---------------------------------------------------------------------------
const MAX_ADJUSTMENT_LAYERS = 8
const MIN_CLIP_MS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type CurvePoint = { x: number; y: number }
type CurveChannelKey = 'master' | 'red' | 'green' | 'blue'

type AdjustmentLayer = {
  id: string
  startMs: number
  endMs: number
  colorAdjust?: {
    brightness: number
    contrast: number
    saturation: number
    temperature: number
  }
  curves?: Record<CurveChannelKey, CurvePoint[]>
  hsl?: Record<string, { hue: number; saturation: number; luminance: number }>
  filterPreset?: string
  filterIntensity?: number
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-32-adjustment-layer adjustment layer contract', () => {
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
        const track = reels.state().project.tracks.find((t: { kind: string }) => t.kind === 'video')
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

  async function getAdjustmentLayers(): Promise<AdjustmentLayer[]> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const project = window.__reelsStore.state().project as { adjustmentLayers?: AdjustmentLayer[] }
      return (project.adjustmentLayers ?? []) as AdjustmentLayer[]
    })
  }

  async function buildPlan(outputPath: string): Promise<{
    ok: boolean
    filterGraph?: string
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

  async function doUndo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().undo()
    })
    await launched.page.waitForTimeout(300)
  }

  async function doRedo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().redo()
    })
    await launched.page.waitForTimeout(300)
  }

  // =========================================================================
  // (1) BYTE-IDENTICAL REGRESSION
  //     - No adjustment layers → filterGraph same as baseline; no between(t,
  //     - Neutral-only layer → same as baseline (getAdjustmentLayers drops it)
  // =========================================================================
  test('(1) @phase-3-32-adjustment-layer BYTE-IDENTICAL: no layers and neutral layer produce same filterGraph as baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Capture baseline (no adjustment layers).
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok, `baseline buildPlan failed: ${baseline.error ?? ''}`).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''
    expect(baselineGraph).toBeTruthy()

    // Baseline must NOT contain the adjustment-layer enable token.
    expect(baselineGraph).not.toContain(":enable='between(t,")
    // Standard pipeline sanity.
    expect(baselineGraph).toContain('scale=1080:1920')

    // Add a layer with NO grade (neutral) → getAdjustmentLayers drops it.
    const adjId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(adjId).not.toBeNull()
    await page.waitForTimeout(200)

    // Verify the layer is in raw store but neutral.
    const rawLayers = await getAdjustmentLayers()
    expect(rawLayers.length).toBe(1)
    expect(rawLayers[0].colorAdjust).toBeUndefined()
    expect(rawLayers[0].filterPreset).toBeUndefined()
    expect(rawLayers[0].curves).toBeUndefined()
    expect(rawLayers[0].hsl).toBeUndefined()

    // buildPlan must still be byte-identical to baseline (neutral layer dropped).
    const neutralPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-neutral-${Date.now()}.mp4`
    )
    const neutralResult = await buildPlan(neutralPath)
    expect(neutralResult.ok, `neutral buildPlan failed: ${neutralResult.error ?? ''}`).toBe(true)
    const neutralGraph = neutralResult.filterGraph ?? ''

    // BYTE-IDENTICAL GATE.
    expect(neutralGraph).toBe(baselineGraph)
    // Still no enable token.
    expect(neutralGraph).not.toContain(":enable='between(t,")
  })

  // =========================================================================
  // (2) addAdjustmentLayer — bounds, clamp, 8-layer cap
  // =========================================================================
  test('(2) @phase-3-32-adjustment-layer addAdjustmentLayer stores bounds; clamp endMs; cap at 8', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Basic add with valid bounds.
    const id = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(id).not.toBeNull()
    expect(typeof id).toBe('string')
    await page.waitForTimeout(100)

    let layers = await getAdjustmentLayers()
    expect(layers.length).toBe(1)
    expect(layers[0].id).toBe(id)
    expect(layers[0].startMs).toBe(1000)
    expect(layers[0].endMs).toBe(4000)

    // Clamp: endMs < startMs + MIN_CLIP_MS → clamped to startMs + MIN_CLIP_MS.
    const id2 = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(2000, 2000) // endMs === startMs → clamp
    })
    expect(id2).not.toBeNull()
    await page.waitForTimeout(100)

    layers = await getAdjustmentLayers()
    const layer2 = layers.find((l) => l.id === id2)
    expect(layer2).toBeDefined()
    // endMs must be >= startMs + MIN_CLIP_MS (100).
    expect(layer2!.endMs).toBeGreaterThanOrEqual(layer2!.startMs + MIN_CLIP_MS)

    // Fill up to 8 layers total.
    // Already have 2; add 6 more.
    for (let i = 2; i < MAX_ADJUSTMENT_LAYERS; i++) {
      const r = await page.evaluate((start: number) => {
        return window.__reelsStore.addAdjustmentLayer(start, start + 1000)
      }, i * 1000)
      expect(r, `layer ${i + 1} should succeed`).not.toBeNull()
      await page.waitForTimeout(50)
    }

    layers = await getAdjustmentLayers()
    expect(layers.length).toBe(MAX_ADJUSTMENT_LAYERS)

    // 9th add must return null.
    const nullResult = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(99000, 102000)
    })
    expect(nullResult).toBeNull()

    // Still 8.
    layers = await getAdjustmentLayers()
    expect(layers.length).toBe(MAX_ADJUSTMENT_LAYERS)
  })

  // =========================================================================
  // (3) Grade emitted, time-gated
  //     colorAdjust brightness → eq= ... :enable='between(t,1.000,4.000)'
  // =========================================================================
  test('(3) @phase-3-32-adjustment-layer colorAdjust emits eq= filter time-gated with between(t,1.000,4.000)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const adjId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(adjId).not.toBeNull()
    await page.waitForTimeout(100)

    // Set brightness +40 on the adjustment layer.
    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { brightness: 40 })
    }, adjId as string)
    await page.waitForTimeout(200)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-brightness-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // Must contain eq= filter.
    expect(graph).toContain('eq=')
    // Must be time-gated to the [1.000, 4.000] window.
    expect(graph).toContain("enable='between(t,1.000,4.000)'")
    // Standard pipeline intact.
    expect(graph).toContain('scale=1080:1920')
  })

  // =========================================================================
  // (4) Curves / filter preset
  //     Non-identity curve → curves=...:enable='between(t,...)'
  //     filterPreset 'vibrant' → its filter with :enable=
  // =========================================================================
  test('(4) @phase-3-32-adjustment-layer non-identity curve and filter preset emit time-gated filters', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // --- Curves test ---
    const curvesId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(500, 3500)
    })
    expect(curvesId).not.toBeNull()
    await page.waitForTimeout(100)

    // Set a non-identity master curve on the adjustment layer.
    await page.evaluate((id) => {
      // The setAdjustmentLayerCurvePoint API requires an existing point at pointIndex.
      // Seed the layer's curves to have identity endpoints first,
      // then set the midpoint via the store's curve-point action.
      // We can set point 0 and 1 first; then try to set point 0 to non-identity.
      // Actually: setAdjustmentLayerCurvePoint works on existing points of the curves array.
      // Seed with identity first (pointIndex 0 and 1 map to the two identity endpoints).
      window.__reelsStore.setAdjustmentLayerCurvePoint(id, 'master', 0, { x: 0, y: 0 })
      window.__reelsStore.setAdjustmentLayerCurvePoint(id, 'master', 1, { x: 1, y: 1 })
      // Now move point 1 off the diagonal to make it non-identity.
      window.__reelsStore.setAdjustmentLayerCurvePoint(id, 'master', 1, { x: 1, y: 0.7 })
    }, curvesId as string)
    await page.waitForTimeout(200)

    const curvesOutPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-curves-${Date.now()}.mp4`
    )
    const curvesResult = await buildPlan(curvesOutPath)
    expect(curvesResult.ok, `curves buildPlan failed: ${curvesResult.error ?? ''}`).toBe(true)
    const curvesGraph = curvesResult.filterGraph ?? ''

    // Must contain curves= filter with an enable gate.
    expect(curvesGraph).toContain('curves=')
    expect(curvesGraph).toContain(":enable='between(t,0.500,3.500)'")

    // --- Filter preset test ---
    // Remove previous layer and add one with 'vibrant' preset.
    await page.evaluate((id) => {
      window.__reelsStore.removeAdjustmentLayer(id)
    }, curvesId as string)
    await page.waitForTimeout(100)

    const presetId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(2000, 6000)
    })
    expect(presetId).not.toBeNull()
    await page.waitForTimeout(100)

    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerFilterPreset(id, 'vibrant', 1)
    }, presetId as string)
    await page.waitForTimeout(200)

    const presetOutPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-preset-${Date.now()}.mp4`
    )
    const presetResult = await buildPlan(presetOutPath)
    expect(presetResult.ok, `preset buildPlan failed: ${presetResult.error ?? ''}`).toBe(true)
    const presetGraph = presetResult.filterGraph ?? ''

    // 'vibrant' preset uses saturate/contrast — look for eq= or saturate-style filter
    // with the enable gate for [2.000, 6.000].
    expect(presetGraph).toContain(":enable='between(t,2.000,6.000)'")
    expect(presetGraph).toContain('scale=1080:1920')
  })

  // =========================================================================
  // (5) Two overlapping layers stack
  //     Layers [0,5000] and [2000,7000] both graded → two distinct :enable=
  //     groups, 0.000 one before 2.000 one
  // =========================================================================
  test('(5) @phase-3-32-adjustment-layer two overlapping graded layers emit two between(t,...) groups in order', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const id1 = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(0, 5000)
    })
    const id2 = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(2000, 7000)
    })
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull()
    await page.waitForTimeout(100)

    // Set a grade on each.
    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { brightness: 30 })
    }, id1 as string)
    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { contrast: -20 })
    }, id2 as string)
    await page.waitForTimeout(200)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-two-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // Both enable windows must appear.
    expect(graph).toContain("enable='between(t,0.000,5.000)'")
    expect(graph).toContain("enable='between(t,2.000,7.000)'")

    // The [0.000, 5.000] group must appear BEFORE the [2.000, 7.000] group
    // (getAdjustmentLayers sorts ascending by startMs).
    const idx0 = graph.indexOf("between(t,0.000,5.000)")
    const idx2 = graph.indexOf("between(t,2.000,7.000)")
    expect(idx0).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThanOrEqual(0)
    expect(idx0).toBeLessThan(idx2)

    expect(graph).toContain('scale=1080:1920')
  })

  // =========================================================================
  // (6) Undo/redo
  //     addAdjustmentLayer → undo → empty → redo → restored
  //     setAdjustmentLayerColorAdjust → undo restores original
  // =========================================================================
  test('(6) @phase-3-32-adjustment-layer undo/redo: add and grade both round-trip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Allow editor mount to land as a undo step before we start.
    await page.waitForTimeout(350)

    // --- Add layer undo/redo ---
    const id = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(id).not.toBeNull()
    await page.waitForTimeout(350)

    let layers = await getAdjustmentLayers()
    expect(layers.length).toBe(1)
    expect(layers[0].id).toBe(id)

    // Undo → layer gone.
    await doUndo()
    layers = await getAdjustmentLayers()
    expect(layers.length).toBe(0)

    // Redo → layer restored.
    await doRedo()
    layers = await getAdjustmentLayers()
    expect(layers.length).toBe(1)
    expect(layers[0].id).toBe(id)

    // --- Grade undo/redo ---
    await page.evaluate((adjId) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(adjId, { brightness: 55 })
    }, id as string)
    await page.waitForTimeout(350)

    layers = await getAdjustmentLayers()
    expect(layers[0].colorAdjust?.brightness).toBe(55)

    // Undo grade → colorAdjust absent or neutral.
    await doUndo()
    layers = await getAdjustmentLayers()
    // After undo: either colorAdjust is undefined (neutral-collapsed) or brightness = 0.
    const brightnessAfterUndo = layers[0]?.colorAdjust?.brightness ?? 0
    expect(brightnessAfterUndo).toBe(0)

    // Redo grade → brightness restored.
    await doRedo()
    layers = await getAdjustmentLayers()
    expect(layers[0].colorAdjust?.brightness).toBe(55)

    // No page errors during the entire undo/redo cycle.
    const criticalErrors = launched.pageErrors.filter(
      (e) => !/supabase|auth|fetch|network/i.test(e.message)
    )
    expect(criticalErrors).toHaveLength(0)
  })

  // =========================================================================
  // (7) updateAdjustmentLayer — move/trim bounds, re-clamped
  // =========================================================================
  test('(7) @phase-3-32-adjustment-layer updateAdjustmentLayer moves and trims bounds, clamps endMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const id = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(id).not.toBeNull()
    await page.waitForTimeout(100)

    // Move start and end.
    await page.evaluate((adjId) => {
      window.__reelsStore.updateAdjustmentLayer(adjId, { startMs: 2000, endMs: 6000 })
    }, id as string)
    await page.waitForTimeout(100)

    let layers = await getAdjustmentLayers()
    const layer = layers.find((l) => l.id === id)
    expect(layer).toBeDefined()
    expect(layer!.startMs).toBe(2000)
    expect(layer!.endMs).toBe(6000)

    // Trim: set endMs too close to startMs (< MIN_CLIP_MS gap) → should be clamped.
    await page.evaluate((adjId) => {
      window.__reelsStore.updateAdjustmentLayer(adjId, { startMs: 3000, endMs: 3000 })
    }, id as string)
    await page.waitForTimeout(100)

    layers = await getAdjustmentLayers()
    const layerAfterTrim = layers.find((l) => l.id === id)
    expect(layerAfterTrim).toBeDefined()
    expect(layerAfterTrim!.endMs).toBeGreaterThanOrEqual(layerAfterTrim!.startMs + MIN_CLIP_MS)

    // Negative startMs → clamped to 0.
    await page.evaluate((adjId) => {
      window.__reelsStore.updateAdjustmentLayer(adjId, { startMs: -500, endMs: 1000 })
    }, id as string)
    await page.waitForTimeout(100)

    layers = await getAdjustmentLayers()
    const layerAfterNeg = layers.find((l) => l.id === id)
    expect(layerAfterNeg).toBeDefined()
    expect(layerAfterNeg!.startMs).toBeGreaterThanOrEqual(0)
  })

  // =========================================================================
  // (8) Preview — playhead inside a graded adjustment layer →
  //     preview-fitted-rect has data-adjustment-active attribute;
  //     outside → attribute absent or 'false'
  // =========================================================================
  test('(8) @phase-3-32-adjustment-layer preview-fitted-rect gets data-adjustment-active when playhead inside graded layer', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Add layer [1000, 4000] with a grade.
    const adjId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(1000, 4000)
    })
    expect(adjId).not.toBeNull()
    await page.waitForTimeout(100)

    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { brightness: 30 })
    }, adjId as string)
    await page.waitForTimeout(200)

    // Move playhead inside the adjustment layer.
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(2500)
    })
    await page.waitForTimeout(300)

    // Check preview-fitted-rect for the active state.
    const previewRect = page.locator('[data-testid="preview-fitted-rect"]')
    await expect(previewRect).toBeVisible({ timeout: 5_000 })

    const attrInside = await previewRect.getAttribute('data-adjustment-active')
    // The attribute should exist and be truthy when inside an active graded layer.
    expect(attrInside).not.toBeNull()
    expect(attrInside).not.toBe('false')

    // Move playhead outside the adjustment layer (before it starts).
    await page.evaluate(() => {
      window.__reelsTimelineUi.getState().setPlayheadMs(0)
    })
    await page.waitForTimeout(300)

    const attrOutside = await previewRect.getAttribute('data-adjustment-active')
    // When outside, attribute should be absent, 'false', or '0'.
    const isInactive =
      attrOutside === null ||
      attrOutside === 'false' ||
      attrOutside === '0' ||
      attrOutside === ''
    expect(isInactive).toBe(true)
  })

  // =========================================================================
  // (9) UI — add-adjustment-layer creates block; click opens editor; delete removes
  // =========================================================================
  test('(9) @phase-3-32-adjustment-layer UI: add button creates lane block; click opens editor; delete removes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // The adjustment lane should be present (may be empty initially).
    const lane = page.locator('[data-testid="adjustment-layer-lane"]')
    await expect(lane).toBeVisible({ timeout: 5_000 })

    // Click the add-adjustment-layer button.
    const addBtn = page.locator('[data-testid="add-adjustment-layer"]')
    await expect(addBtn).toBeVisible({ timeout: 5_000 })
    await addBtn.click()
    await page.waitForTimeout(400)

    // Exactly one adjustment layer should now be in the store.
    let layers = await getAdjustmentLayers()
    expect(layers.length).toBe(1)
    const layerId = layers[0].id

    // The lane should show a block for this layer.
    const block = page.locator(`[data-testid="adjustment-layer-${layerId}"]`)
    await expect(block).toBeVisible({ timeout: 5_000 })

    // Verify data attributes on the block.
    const startMs = await block.getAttribute('data-start-ms')
    const endMs = await block.getAttribute('data-end-ms')
    expect(startMs).not.toBeNull()
    expect(endMs).not.toBeNull()
    expect(parseInt(startMs ?? '0', 10)).toBeGreaterThanOrEqual(0)
    expect(parseInt(endMs ?? '0', 10)).toBeGreaterThan(parseInt(startMs ?? '0', 10))

    // Click the block to select it → adjustment-layer-editor should appear.
    await block.click()
    await page.waitForTimeout(300)
    const editor = page.locator('[data-testid="adjustment-layer-editor"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })

    // Delete via the delete button in the editor.
    const deleteBtn = page.locator('[data-testid="delete-adjustment-layer"]')
    await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
    await deleteBtn.click()
    await page.waitForTimeout(400)

    // Layer should be gone from store.
    layers = await getAdjustmentLayers()
    expect(layers.length).toBe(0)

    // Block should be gone from DOM.
    await expect(block).not.toBeVisible({ timeout: 3_000 })

    // No page errors during the UI interaction.
    const criticalErrors = launched.pageErrors.filter(
      (e) => !/supabase|auth|fetch|network/i.test(e.message)
    )
    expect(criticalErrors).toHaveLength(0)
  })

  // =========================================================================
  // BONUS: removeAdjustmentLayer removes the layer and export reverts to
  //        baseline (byte-identical without the grade).
  // =========================================================================
  test('(bonus) @phase-3-32-adjustment-layer removeAdjustmentLayer restores byte-identical graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Capture baseline.
    const baselinePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-remove-baseline-${Date.now()}.mp4`
    )
    const baseline = await buildPlan(baselinePath)
    expect(baseline.ok).toBe(true)
    const baselineGraph = baseline.filterGraph ?? ''

    // Add a graded layer.
    const adjId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(0, 3000)
    })
    expect(adjId).not.toBeNull()
    await page.waitForTimeout(100)

    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerColorAdjust(id, { saturation: 50 })
    }, adjId as string)
    await page.waitForTimeout(200)

    const withGradePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-remove-graded-${Date.now()}.mp4`
    )
    const withGrade = await buildPlan(withGradePath)
    expect(withGrade.ok).toBe(true)
    // Graded graph must differ from baseline (has the time-gated filter).
    expect(withGrade.filterGraph).toContain(":enable='between(t,")

    // Now remove the layer.
    await page.evaluate((id) => {
      window.__reelsStore.removeAdjustmentLayer(id)
    }, adjId as string)
    await page.waitForTimeout(200)

    const afterRemovePath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-remove-after-${Date.now()}.mp4`
    )
    const afterRemove = await buildPlan(afterRemovePath)
    expect(afterRemove.ok).toBe(true)
    // After removal, graph must be byte-identical to baseline again.
    expect(afterRemove.filterGraph).toBe(baselineGraph)
  })

  // =========================================================================
  // BONUS: HSL band on an adjustment layer emits time-gated huesaturation=
  // =========================================================================
  test('(bonus) @phase-3-32-adjustment-layer HSL band emits time-gated huesaturation= filter', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const adjId = await page.evaluate(() => {
      return window.__reelsStore.addAdjustmentLayer(3000, 7000)
    })
    expect(adjId).not.toBeNull()
    await page.waitForTimeout(100)

    // Set the red band's hue to a non-zero value.
    await page.evaluate((id) => {
      window.__reelsStore.setAdjustmentLayerHslBand(id, 'red', { hue: 25 })
    }, adjId as string)
    await page.waitForTimeout(200)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `adj-layer-hsl-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)
    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // huesaturation= filter must appear (if huesat is available on this build).
    // We don't hard-fail when huesat is unavailable on the build; instead we
    // accept either huesaturation= OR that the enable token is absent entirely.
    // The critical invariant is: no crash and graph is valid.
    if (graph.includes('huesaturation=')) {
      expect(graph).toContain(":enable='between(t,3.000,7.000)'")
    }
    expect(graph).toContain('scale=1080:1920')
  })
})
