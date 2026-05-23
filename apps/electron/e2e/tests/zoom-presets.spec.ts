/**
 * Phase 3.31 — Auto-zoom / punch-in presets (zoom-presets).
 *
 * Covers:
 *  (1)  buildZoomKeyframes (pure) — each of 6 presets at 5000ms: ≥2 KFs,
 *       sorted ascending, every gap ≥ MIN_KEYFRAME_GAP_MS, count ≤ 24.
 *       Unknown id → []. Tiny clip (20ms) → [].
 *  (2)  applyZoomPreset writes transformKeyframes — ≥2 entries; punch-in first
 *       KF scale ≥ 1, last KF scale ≈ 1.12; zoom-out first ≈ 1.20, last ≈ 1.0.
 *  (3)  Composition onto a base transform — base scale 1.3, x 0.1, punch-in →
 *       last KF scale ≈ 1.3*1.12, every KF x ≈ 0.1.
 *  (4)  Scale never < 1 — base scale 0.6 + zoom-out (end factor 1.0) → every
 *       KF scale ≥ 1 (Math.max(1,...) clamp).
 *  (5)  Replace, not accumulate — apply punch-in then zoom-in-slow → KFs reflect
 *       only the second preset.
 *  (6)  Export — clip with zoom preset → buildPlan filterGraph contains zoompan
 *       token.
 *  (7)  BYTE-IDENTICAL — no preset applied → buildPlan graph identical to baseline
 *       (no zoompan added).
 *  (8)  Undo/redo — applyZoomPreset → undo restores prior KFs → redo re-applies.
 *       One step.
 *  (9)  Overlay clip — applyZoomPreset on an OverlayClip writes transformKeyframes.
 * (10)  Short clip no-op — clip too short to host 2 KFs → no-op (KFs stay
 *       undefined).
 * (11)  UI — effects-section-zoom-presets renders 6 zoom-preset-<id> buttons;
 *       clicking one writes transformKeyframes.
 *
 * @phase-3-31-zoom-presets
 */

import { expect, test } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants mirrored from shared/project.ts
// ---------------------------------------------------------------------------
const MAX_KEYFRAMES_PER_CLIP = 24
const MIN_KEYFRAME_GAP_MS = 30

// ---------------------------------------------------------------------------
// Type bridges
// ---------------------------------------------------------------------------
type ReelsStore = {
  state: () => {
    project: {
      tracks: Array<{
        id: string
        kind: string
        clips: Array<Record<string, unknown>>
      }>
    }
  }
  addMedia: (a: unknown) => void
  addClip: (c: unknown) => void
  setClipTransform: (id: string, partial: Record<string, number>) => void
  applyZoomPreset: (id: string, presetId: string) => void
  addVideoTrack: () => string | null
  newId: () => string
}

type ZoomPreset = {
  id: string
  label: string
  description: string
  specs: Array<{ atFrac: number; scaleFactor: number; xOffset: number; yOffset: number }>
}

type TransformKeyframe = {
  atMs: number
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number }
}

declare global {
  interface Window {
    __reelsStore: ReelsStore
    __reelsZoomPresets: {
      ZOOM_PRESETS: readonly ZoomPreset[]
      buildZoomKeyframes: (presetId: string, clipDurationMs: number) => TransformKeyframe[]
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
      getState: () => { setPlayheadMs: (ms: number) => void; selectClip: (id: string) => void }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function setup(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
  await page.evaluate(async () => {
    window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
    await new Promise((r) => setTimeout(r, 900))
  })
}

async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
  await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
    null,
    { timeout: 8_000 }
  )
  await page.waitForFunction(
    () => !!(window as unknown as { __reelsZoomPresets?: unknown }).__reelsZoomPresets,
    null,
    { timeout: 8_000 }
  )
}

async function addFixtureMedia(
  launched: LaunchedApp
): Promise<{ mediaId: string; durationMs: number }> {
  const fixture = process.env.E2E_FIXTURE_MP4
  if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
  const { page } = launched
  return page.evaluate(async (filePath: string) => {
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
  launched: LaunchedApp,
  mediaId: string,
  durationMs: number,
  startMs = 0,
  trackId?: string | null
): Promise<string> {
  const { page } = launched
  return page.evaluate(
    ({ mid, dur, st, tid }) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const track = tid
        ? reels.state().project.tracks.find((t) => t.id === tid)
        : reels.state().project.tracks.find((t) => t.kind === 'video')
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
    { mid: mediaId, dur: durationMs, st: startMs, tid: trackId ?? null }
  )
}

async function getClip(
  launched: LaunchedApp,
  clipId: string
): Promise<Record<string, unknown> | null> {
  return (await launched.page.evaluate((cid) => {
    const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
    for (const t of reels.state().project.tracks)
      for (const c of t.clips) if (c.id === cid) return c
    return null
  }, clipId)) as Record<string, unknown> | null
}

async function buildPlan(
  launched: LaunchedApp,
  outputPath: string
): Promise<{ ok: boolean; filterGraph?: string; error?: string }> {
  return launched.page.evaluate(
    async ({ outPath }) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const project = (reels.state() as { project: unknown }).project
      return await window.electron.exporter.buildPlan(project, 'instagram-reels', outPath)
    },
    { outPath: outputPath }
  )
}

/** Sleep past the zundo 200ms throttle so consecutive mutations get distinct undo entries. */
async function tick(launched: LaunchedApp): Promise<void> {
  await launched.page.waitForTimeout(250)
}

function undo(launched: LaunchedApp): Promise<void> {
  return launched.page.evaluate(() => {
    ;(window as unknown as { __reelsUndoRedo: Window['__reelsUndoRedo'] }).__reelsUndoRedo
      .getState()
      .undo()
  })
}

function redo(launched: LaunchedApp): Promise<void> {
  return launched.page.evaluate(() => {
    ;(window as unknown as { __reelsUndoRedo: Window['__reelsUndoRedo'] }).__reelsUndoRedo
      .getState()
      .redo()
  })
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('@phase-3-31-zoom-presets auto-zoom / punch-in presets', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    await setup(launched)
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
          const { rmSync: rm } = await import('node:fs')
          rm(userDataDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      launched = null
    }
  })

  test.afterEach(async () => {
    // Clean up any exported plan files.
    const dir = path.join(os.tmpdir(), 'reels-studio-e2e')
    for (const f of [
      'zoom-plan-baseline.mp4',
      'zoom-plan-preset.mp4'
    ]) {
      const p = path.join(dir, f)
      if (existsSync(p)) {
        try { rmSync(p) } catch { /* ignore */ }
      }
    }
  })

  // -------------------------------------------------------------------------
  // (1) buildZoomKeyframes (pure) — all 6 presets at 5000ms, edge cases
  // -------------------------------------------------------------------------
  test('(1) @phase-3-31-zoom-presets buildZoomKeyframes: all 6 presets valid at 5000ms; unknown id → []; tiny clip → []', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)

    const results = await launched.page.evaluate(
      ({ maxKfs, minGap }: { maxKfs: number; minGap: number }) => {
        const zp = (window as unknown as { __reelsZoomPresets: Window['__reelsZoomPresets'] }).__reelsZoomPresets
        const DURATION = 5000
        const presetIds = zp.ZOOM_PRESETS.map((p) => p.id)

        const presetResults = presetIds.map((id) => {
          const kfs = zp.buildZoomKeyframes(id, DURATION)
          const sorted = [...kfs].sort((a, b) => a.atMs - b.atMs)
          const gapOk = sorted.every((kf, i) => {
            if (i === 0) return true
            return kf.atMs - sorted[i - 1].atMs >= minGap
          })
          return {
            id,
            count: kfs.length,
            atLeast2: kfs.length >= 2,
            isSorted: kfs.every((kf, i) => i === 0 || kf.atMs >= kfs[i - 1].atMs),
            gapOk,
            withinMax: kfs.length <= maxKfs
          }
        })

        const unknownResult = zp.buildZoomKeyframes('does-not-exist', 5000)
        const tinyResult = zp.buildZoomKeyframes('punch-in', 20)

        return { presetResults, unknownEmpty: unknownResult.length === 0, tinyEmpty: tinyResult.length === 0 }
      },
      { maxKfs: MAX_KEYFRAMES_PER_CLIP, minGap: MIN_KEYFRAME_GAP_MS }
    )

    for (const r of results.presetResults) {
      expect(r.atLeast2, `${r.id}: expected ≥2 KFs, got ${r.count}`).toBe(true)
      expect(r.isSorted, `${r.id}: KFs not sorted ascending`).toBe(true)
      expect(r.gapOk, `${r.id}: gap < MIN_KEYFRAME_GAP_MS`).toBe(true)
      expect(r.withinMax, `${r.id}: KF count ${r.count} exceeds MAX_KEYFRAMES_PER_CLIP`).toBe(true)
    }
    expect(results.unknownEmpty, 'unknown preset id should return []').toBe(true)
    expect(results.tinyEmpty, 'tiny 20ms clip should return []').toBe(true)
  })

  // -------------------------------------------------------------------------
  // (2) applyZoomPreset writes transformKeyframes with correct scale values
  // -------------------------------------------------------------------------
  test('(2) @phase-3-31-zoom-presets applyZoomPreset writes ≥2 KFs; punch-in last scale ≈ 1.12; zoom-out first ≈ 1.20 last ≈ 1.0', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    // Apply punch-in.
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)

    let clip = await getClip(launched, cid)
    expect(clip).not.toBeNull()
    const punchKfs = clip!.transformKeyframes as TransformKeyframe[] | undefined
    expect(Array.isArray(punchKfs)).toBe(true)
    expect((punchKfs as TransformKeyframe[]).length).toBeGreaterThanOrEqual(2)

    const punchSorted = [...(punchKfs as TransformKeyframe[])].sort((a, b) => a.atMs - b.atMs)
    // First KF: base scale (1.0) * 1.0 = 1.0, clamped ≥ 1 → 1.0
    expect(punchSorted[0].transform.scale).toBeGreaterThanOrEqual(1)
    // Last KF: scale factor 1.12 → scale ≈ 1.12
    const punchLast = punchSorted[punchSorted.length - 1]
    expect(punchLast.transform.scale).toBeCloseTo(1.12, 2)

    // Apply zoom-out (replace).
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'zoom-out')
    }, cid)

    clip = await getClip(launched, cid)
    const zoutKfs = clip!.transformKeyframes as TransformKeyframe[] | undefined
    expect(Array.isArray(zoutKfs)).toBe(true)

    const zoutSorted = [...(zoutKfs as TransformKeyframe[])].sort((a, b) => a.atMs - b.atMs)
    // zoom-out first factor 1.2 → composed scale = max(1, 1.0 * 1.2) = 1.2
    expect(zoutSorted[0].transform.scale).toBeCloseTo(1.2, 2)
    // zoom-out last factor 1.0 → composed scale = max(1, 1.0 * 1.0) = 1.0
    const zoutLast = zoutSorted[zoutSorted.length - 1]
    expect(zoutLast.transform.scale).toBeCloseTo(1.0, 2)
  })

  // -------------------------------------------------------------------------
  // (3) Composition onto a base transform (scale 1.3, x 0.1)
  // -------------------------------------------------------------------------
  test('(3) @phase-3-31-zoom-presets composition onto base transform: scale multiplied, x offset preserved', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    // Set static base transform: scale 1.3, x offset 0.1
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setClipTransform(id, { scale: 1.3, x: 0.1 })
    }, cid)

    // Apply punch-in: specs = [{scaleFactor:1.0, xOffset:0}, {scaleFactor:1.12, xOffset:0}]
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)

    const clip = await getClip(launched, cid)
    expect(clip).not.toBeNull()
    const kfs = clip!.transformKeyframes as TransformKeyframe[] | undefined
    expect(Array.isArray(kfs)).toBe(true)

    const sorted = [...(kfs as TransformKeyframe[])].sort((a, b) => a.atMs - b.atMs)
    expect(sorted.length).toBeGreaterThanOrEqual(2)

    // Last KF: scale = max(1, 1.3 * 1.12) = 1.456
    const lastKf = sorted[sorted.length - 1]
    expect(lastKf.transform.scale).toBeCloseTo(1.3 * 1.12, 2)

    // All KFs: x = base.x (0.1) + xOffset (0) = 0.1
    for (const kf of sorted) {
      expect(kf.transform.x).toBeCloseTo(0.1, 4)
    }
  })

  // -------------------------------------------------------------------------
  // (4) Scale clamp — base scale 0.6 + zoom-out → all KF scales ≥ 1
  // -------------------------------------------------------------------------
  test('(4) @phase-3-31-zoom-presets scale never < 1: base scale 0.6 + zoom-out → every KF scale ≥ 1', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    // Set base scale to 0.6 (below 1 — would reveal gutters if unclamped)
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.setClipTransform(id, { scale: 0.6 })
    }, cid)

    // zoom-out: specs = [{scaleFactor:1.2}, {scaleFactor:1.0}]
    // Without clamp: 0.6*1.0 = 0.6 (would be < 1).
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'zoom-out')
    }, cid)

    const clip = await getClip(launched, cid)
    const kfs = clip!.transformKeyframes as TransformKeyframe[] | undefined
    expect(Array.isArray(kfs)).toBe(true)

    for (const kf of kfs as TransformKeyframe[]) {
      expect(kf.transform.scale, `scale ${kf.transform.scale} should be ≥ 1`).toBeGreaterThanOrEqual(1)
    }
    // The end factor 1.0 → composed = max(1, 0.6 * 1.0) = 1.0
    const sorted = [...(kfs as TransformKeyframe[])].sort((a, b) => a.atMs - b.atMs)
    const last = sorted[sorted.length - 1]
    expect(last.transform.scale).toBeCloseTo(1.0, 2)
  })

  // -------------------------------------------------------------------------
  // (5) Replace, not accumulate
  // -------------------------------------------------------------------------
  test('(5) @phase-3-31-zoom-presets second applyZoomPreset replaces first, not accumulates', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    // Apply punch-in first.
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)

    const afterFirst = await getClip(launched, cid)
    const firstKfs = afterFirst!.transformKeyframes as TransformKeyframe[]
    const firstLastScale = [...firstKfs].sort((a, b) => a.atMs - b.atMs).slice(-1)[0].transform.scale

    // Apply zoom-in-slow (end factor 1.25).
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'zoom-in-slow')
    }, cid)

    const afterSecond = await getClip(launched, cid)
    const secondKfs = afterSecond!.transformKeyframes as TransformKeyframe[]
    const secondSorted = [...secondKfs].sort((a, b) => a.atMs - b.atMs)
    const secondLastScale = secondSorted.slice(-1)[0].transform.scale

    // zoom-in-slow last scale factor = 1.25 → NOT 1.12 (punch-in)
    expect(secondLastScale).toBeCloseTo(1.25, 2)
    // Verify it differs from punch-in (so it truly replaced)
    expect(Math.abs(secondLastScale - firstLastScale)).toBeGreaterThan(0.05)
    // The KF count should be 2 (zoom-in-slow has 2 specs), not the punch-in count stacked.
    expect(secondKfs.length).toBe(2)
  })

  // -------------------------------------------------------------------------
  // (6) Export — zoom preset → filterGraph contains zoompan token
  // -------------------------------------------------------------------------
  test('(6) @phase-3-31-zoom-presets export after applyZoomPreset → filterGraph contains zoompan', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'zoom-plan-preset.mp4')
    const result = await buildPlan(launched, outPath)

    expect(result.ok).toBe(true)
    expect(result.filterGraph).toBeTruthy()
    // The transform-keyframe export path emits zoompan when scale is animated.
    expect(result.filterGraph).toContain('zoompan')
  })

  // -------------------------------------------------------------------------
  // (7) BYTE-IDENTICAL — no preset → buildPlan graph identical to baseline
  // -------------------------------------------------------------------------
  test('(7) @phase-3-31-zoom-presets BYTE-IDENTICAL: no preset → same filterGraph as pre-preset baseline', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)

    // Add a single clip with NO preset applied.
    await addVideoClip(launched, mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'zoom-plan-baseline.mp4')
    const baseline = await buildPlan(launched, outPath)
    expect(baseline.ok).toBe(true)
    const baseGraph = baseline.filterGraph ?? ''

    // The baseline graph must NOT contain zoompan (no animated transform).
    expect(baseGraph).not.toContain('zoompan')

    // Re-build plan (unchanged state) → identical graph.
    const second = await buildPlan(launched, outPath)
    expect(second.ok).toBe(true)
    expect(second.filterGraph).toBe(baseGraph)
  })

  // -------------------------------------------------------------------------
  // (8) Undo/redo — one step
  // -------------------------------------------------------------------------
  test('(8) @phase-3-31-zoom-presets undo restores prior KFs (undefined); redo re-applies', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    await launched.page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)

    // Wait for addClip mutation to settle in undo history.
    await tick(launched)

    // Verify no keyframes before.
    let clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeUndefined()

    // Apply punch-in.
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)
    await tick(launched)

    clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeDefined()
    expect((clip!.transformKeyframes as TransformKeyframe[]).length).toBeGreaterThanOrEqual(2)

    // Undo — KFs should vanish (back to undefined).
    await undo(launched)
    await launched.page.waitForTimeout(300)

    clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeUndefined()

    // Redo — KFs come back.
    await redo(launched)
    await launched.page.waitForTimeout(300)

    clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeDefined()
    const kfs = clip!.transformKeyframes as TransformKeyframe[]
    expect(kfs.length).toBeGreaterThanOrEqual(2)
    // Verify it's punch-in: last KF scale ≈ 1.12
    const sorted = [...kfs].sort((a, b) => a.atMs - b.atMs)
    expect(sorted[sorted.length - 1].transform.scale).toBeCloseTo(1.12, 2)
  })

  // -------------------------------------------------------------------------
  // (9) Overlay clip — applyZoomPreset writes transformKeyframes
  // -------------------------------------------------------------------------
  test('(9) @phase-3-31-zoom-presets applyZoomPreset on an OverlayClip writes transformKeyframes', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { page } = launched

    // Ensure the overlay track exists, then add an overlay clip.
    const overlayClipId = await page.evaluate(async () => {
      const store = window.__PROJECT_STORE_FOR_TEST__.getState()
      // Ensure overlay track.
      const ensureFn = (store as unknown as { ensureOverlayTrack?: () => string }).ensureOverlayTrack
      const overlayTrackId = ensureFn ? ensureFn.call(store) : (() => {
        const existing = store.project.tracks.find((t) => t.kind === 'overlay')
        if (existing) return existing.id
        throw new Error('no overlay track and ensureOverlayTrack not available')
      })()
      const ovId = `test-ov-${Date.now()}`
      ;(store as unknown as {
        addOverlay: (clip: unknown) => void
      }).addOverlay({
        id: ovId,
        kind: 'overlay',
        trackId: overlayTrackId,
        startMs: 0,
        endMs: 5000,
        source: { type: 'shape', shape: 'rectangle', fill: '#ff0000', fillOpacity: 1, stroke: 'none', strokeWidth: 0, cornerRadius: 0 },
        baseWidthFrac: 0.3,
        baseHeightFrac: 0.3
      })
      return ovId
    })

    // Apply punch-in to the overlay clip.
    await page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, overlayClipId)

    // Read the clip from the overlay track.
    const clip = await page.evaluate((cid) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c
      return null
    }, overlayClipId) as Record<string, unknown> | null

    expect(clip).not.toBeNull()
    const kfs = clip!.transformKeyframes as TransformKeyframe[] | undefined
    expect(Array.isArray(kfs), 'overlay clip should have transformKeyframes after applyZoomPreset').toBe(true)
    expect((kfs as TransformKeyframe[]).length).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  // (10) Short clip no-op — clip too short for 2 keyframes
  // -------------------------------------------------------------------------
  test('(10) @phase-3-31-zoom-presets short clip: applyZoomPreset is a no-op when clip < 2 MIN_KEYFRAME_GAP_MS', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId } = await addFixtureMedia(launched)

    // Add a clip with a very short duration (less than 2 * MIN_KEYFRAME_GAP_MS = 60ms).
    // We override endMs / trimOutMs to make it tiny.
    const shortDur = MIN_KEYFRAME_GAP_MS - 1 // 29ms — too short for 2 keyframes with MIN gap
    const cid = await launched.page.evaluate(
      ({ mid, dur }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
        if (!track) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: track.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: shortDur }
    )

    // Verify KFs are undefined before.
    let clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeUndefined()

    // Apply a preset — should be a no-op.
    await launched.page.evaluate((id) => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      reels.applyZoomPreset(id, 'punch-in')
    }, cid)

    clip = await getClip(launched, cid)
    // KFs must still be undefined (preset was a no-op).
    expect(clip!.transformKeyframes).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // (11) UI — effects-section-zoom-presets has 6 buttons; clicking writes KFs
  // -------------------------------------------------------------------------
  test('(11) @phase-3-31-zoom-presets UI: 6 zoom-preset buttons render in animation tab; click writes transformKeyframes', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor(launched)
    const { mediaId, durationMs } = await addFixtureMedia(launched)
    const cid = await addVideoClip(launched, mediaId, durationMs)
    const { page } = launched

    // Select the clip by clicking its timeline block.
    const block = page.locator(`[data-testid="media-clip-block"][data-clip-id="${cid}"]`).first()
    const blockCount = await block.count()
    if (blockCount > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
    } else {
      await page.evaluate((id) => {
        window.__reelsTimelineUi.getState().selectClip(id)
      }, cid)
      await page.waitForTimeout(200)
    }

    // Open the effects panel.
    const toggleBtn = page.locator('[data-testid="toggle-effects-panel"]')
    await expect(toggleBtn).toBeEnabled({ timeout: 5_000 })
    await toggleBtn.click()
    await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({ timeout: 5_000 })

    // Click the animation tab.
    const animTab = page.locator('[data-testid="effects-tab-animation"]')
    await expect(animTab).toBeVisible({ timeout: 3_000 })
    await animTab.click()
    await page.waitForTimeout(150)

    // The zoom-presets section must be visible.
    await expect(page.locator('[data-testid="effects-section-zoom-presets"]')).toBeVisible({ timeout: 3_000 })

    // All 6 preset buttons must be present.
    const presetIds = ['punch-in', 'punch-in-fast', 'zoom-in-slow', 'zoom-out', 'ken-burns', 'zoom-pulse']
    for (const id of presetIds) {
      await expect(
        page.locator(`[data-testid="zoom-preset-${id}"]`)
      ).toBeVisible({ timeout: 2_000 })
    }

    // Click one preset button (punch-in) — it should write transformKeyframes.
    const punchBtn = page.locator('[data-testid="zoom-preset-punch-in"]')
    await punchBtn.click()
    await page.waitForTimeout(300)

    const clip = await getClip(launched, cid)
    expect(clip!.transformKeyframes).toBeDefined()
    const kfs = clip!.transformKeyframes as TransformKeyframe[]
    expect(Array.isArray(kfs)).toBe(true)
    expect(kfs.length).toBeGreaterThanOrEqual(2)
    // Verify punch-in: last KF scale ≈ 1.12
    const sorted = [...kfs].sort((a, b) => a.atMs - b.atMs)
    expect(sorted[sorted.length - 1].transform.scale).toBeCloseTo(1.12, 2)
  })
})
