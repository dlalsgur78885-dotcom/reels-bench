import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 3 — "변형 + 레이어 합성" (transform + layer compositing).
 *
 * Covers:
 *   Store/data-model:
 *     (1)  setClipTransform clamps scale to MAX_TRANSFORM_SCALE and opacity
 *     (2)  setClipTransform back to identity drops `transform` to undefined
 *     (3)  resetClipTransform clears transform
 *     (4)  addVideoTrack caps at MAX_VIDEO_TRACKS (6) and returns null at cap
 *     (5)  removeVideoTrack refuses to remove the last video track
 *
 *   Renderer/preview:
 *     (6)  Two overlapping video tracks render 2 stacked layers; higher track
 *          carries a larger zIndex
 *     (7)  A non-identity clip transform applies CSS transform + opacity on
 *          the preview <video> element
 *     (8)  transform-indicator badge appears on a transformed clip, gone after
 *          reset
 *
 *   Export buildPlan:
 *     (9)  Two overlapping video tracks → `overlay` in filterGraph
 *     (10) Non-identity transform → `rotate=` + `colorchannelmixer=aa=` present
 *     (11) REGRESSION: single identity-transform track → `concat=n=2`, no
 *          overlay in the filter graph
 *     (12) Transitions stay intra-track: xfade once + overlay for the composite
 *
 *   Real ffmpeg:
 *     (13) exporter:run with two overlapping tracks (one clip scale:0.5) →
 *          valid mp4, ok, file exists, size > 1024, 1080×1920
 */

// ---------------------------------------------------------------------------
// Type helpers matching the window bridges used throughout existing specs.
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
  resetClipTransform: (id: string) => void
  addTransformKeyframe: (id: string, atMs: number, transform?: Record<string, number>) => void
  addVideoTrack: () => string | null
  removeVideoTrack: (tid: string) => void
  newId: () => string
}

declare global {
  interface Window {
    __reelsStore: ReelsStore
    __reelsTimelineUi: {
      getState: () => { setPlayheadMs: (ms: number) => void }
    }
  }
}

test.describe('@phase-3-transform-layers transform + layer compositing', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    // Fresh project for every test.
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 700))
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

  // -------------------------------------------------------------------------
  // Shared helpers — mirrors export.spec.ts conventions.
  // -------------------------------------------------------------------------
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
  }

  async function addFixtureMedia(): Promise<{
    mediaId: string
    durationMs: number
    path: string
  }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    const result = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: ReelsStore
        }
      ).__reelsStore
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
    return { ...result, path: fixture }
  }

  /**
   * Add a video clip to a specific track (or the first video track if
   * trackId is not supplied — mirrors the legacy helper in export.spec.ts).
   */
  async function addVideoClip(
    mediaId: string,
    durationMs: number,
    startMs = 0,
    trackId?: string
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mid, dur, st, tid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: ReelsStore
          }
        ).__reelsStore
        // Resolve which track to use.
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

  async function getClipFromState(
    clipId: string
  ): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: ReelsStore
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  // -------------------------------------------------------------------------
  // Scenario (1) — setClipTransform clamps scale and opacity
  // -------------------------------------------------------------------------
  test('(1) setClipTransform clamps scale > MAX and opacity < 0', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Set scale way over MAX_TRANSFORM_SCALE (8) and opacity below 0.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 999, opacity: -5 }
      )
    }, cid)

    const clip = await getClipFromState(cid)
    expect(clip).not.toBeNull()
    const transform = clip!.transform as Record<string, number> | undefined
    expect(transform).toBeDefined()
    // scale must be clamped to MAX_TRANSFORM_SCALE = 8
    expect(transform!.scale).toBe(8)
    // opacity clamped to 0 (not -5) — but opacity=0 is identity for opacity
    // alone? No: opacity=0 combined with scale=8 is non-identity → stored.
    expect(transform!.opacity).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Scenario (2) — setClipTransform back to identity drops transform field
  // -------------------------------------------------------------------------
  test('(2) setClipTransform to identity drops transform to undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // First set a non-identity transform.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 1.5 }
      )
    }, cid)
    let clip = await getClipFromState(cid)
    expect((clip!.transform as Record<string, number> | undefined)?.scale).toBe(1.5)

    // Now restore to identity exactly — transform must become undefined.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 }
      )
    }, cid)
    clip = await getClipFromState(cid)
    expect(clip!.transform).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Scenario (3) — resetClipTransform clears transform
  // -------------------------------------------------------------------------
  test('(3) resetClipTransform clears transform to undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { rotation: 45 }
      )
    }, cid)
    let clip = await getClipFromState(cid)
    expect(clip!.transform).toBeDefined()

    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.resetClipTransform(id)
    }, cid)
    clip = await getClipFromState(cid)
    expect(clip!.transform).toBeUndefined()
  })

  test('slide 13: transform reset clears keyframed transform values too', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate(
      ({ id, dur }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        reels.addTransformKeyframe(id, 0, { scale: 1.44, rotation: 16 })
        reels.addTransformKeyframe(id, Math.min(2000, dur), {
          scale: 1.44,
          rotation: 16
        })
        ;(
          window as unknown as {
            __reelsTimelineUi: {
              getState: () => {
                setPlayheadMs: (ms: number) => void
                selectClip: (id: string | null) => void
              }
            }
          }
        ).__reelsTimelineUi.getState().setPlayheadMs(Math.min(1000, dur))
        ;(
          window as unknown as {
            __reelsTimelineUi: {
              getState: () => { selectClip: (id: string | null) => void }
            }
          }
        ).__reelsTimelineUi.getState().selectClip(id)
      },
      { id: cid, dur: durationMs }
    )

    let clip = await getClipFromState(cid)
    expect(clip!.transformKeyframes).toBeDefined()

    await page
      .locator(`[data-testid="media-clip-block"][data-clip-id="${cid}"]`)
      .first()
      .click({ force: true })
    await page.locator('[data-testid="toggle-effects-panel"]').click()
    await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({
      timeout: 3_000
    })
    await page.locator('[data-testid="effects-tab-transform"]').click()
    await page.waitForTimeout(120)
    await expect(page.locator('[data-testid="effects-transform-reset"]')).toBeVisible()
    await page.locator('[data-testid="effects-transform-reset"]').click()
    await page.waitForTimeout(120)

    clip = await getClipFromState(cid)
    expect(clip!.transform).toBeUndefined()
    expect(clip!.transformKeyframes).toBeUndefined()

    const values = await page.evaluate(() => ({
      scale: (
        document.querySelector('[data-testid="effects-transform-scale-input"]') as HTMLInputElement | null
      )?.value,
      rotation: (
        document.querySelector(
          '[data-testid="effects-transform-rotation-input"]'
        ) as HTMLInputElement | null
      )?.value
    }))
    expect(Number(values.scale)).toBeCloseTo(1, 2)
    expect(Number(values.rotation)).toBeCloseTo(0, 2)
  })

  // -------------------------------------------------------------------------
  // Scenario (4) — addVideoTrack caps at MAX_VIDEO_TRACKS (6)
  // -------------------------------------------------------------------------
  test('(4) addVideoTrack caps at MAX_VIDEO_TRACKS=6 and returns null at cap', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const results = await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const initial = reels.state().project.tracks.filter((t) => t.kind === 'video').length
      const ids: (string | null)[] = []
      // Fresh project starts with 1 video track. Add up to MAX (6) total.
      for (let i = initial; i < 6; i++) {
        ids.push(reels.addVideoTrack())
      }
      // One beyond the cap — must return null.
      const overflow = reels.addVideoTrack()
      const finalCount = reels.state().project.tracks.filter((t) => t.kind === 'video').length
      return { ids, overflow, finalCount }
    })

    // All additions up to the cap must return non-null IDs.
    for (const id of results.ids) {
      expect(id).not.toBeNull()
      expect(typeof id).toBe('string')
    }
    // Overflow must be null.
    expect(results.overflow).toBeNull()
    // Final count is exactly 6.
    expect(results.finalCount).toBe(6)
  })

  // -------------------------------------------------------------------------
  // Scenario (5) — removeVideoTrack refuses to remove the last video track
  // -------------------------------------------------------------------------
  test('(5) removeVideoTrack is a no-op when only one video track remains', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const result = await page.evaluate(() => {
      const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
      const videoTracks = reels.state().project.tracks.filter((t) => t.kind === 'video')
      if (videoTracks.length !== 1) return { error: 'expected 1 video track' }
      reels.removeVideoTrack(videoTracks[0].id)
      const after = reels.state().project.tracks.filter((t) => t.kind === 'video').length
      return { after }
    })

    expect(result.after).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Scenario (6) — two overlapping video tracks render 2 stacked layers
  // -------------------------------------------------------------------------
  test('(6) two video tracks with overlapping clips render 2 layers, higher track has larger zIndex', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Track 0 already exists; add a second video track.
    const secondTrackId = await page.evaluate(() => {
      return (window as unknown as { __reelsStore: ReelsStore }).__reelsStore.addVideoTrack()
    })
    expect(secondTrackId).not.toBeNull()

    // Add clip to the first (bottom) video track.
    await addVideoClip(mediaId, durationMs, 0)
    // Add clip to the second (top) video track — overlaps same time range.
    await addVideoClip(mediaId, durationMs, 0, secondTrackId as string)

    // Advance playhead to the middle of the clips so both are active.
    const midMs = Math.floor(durationMs / 2)
    await page.evaluate((ms) => {
      const ui = (window as unknown as {
        __reelsTimelineUi: { getState: () => { setPlayheadMs: (ms: number) => void } }
      }).__reelsTimelineUi
      ui.getState().setPlayheadMs(ms)
    }, midMs)
    // Give React a render cycle.
    await page.waitForTimeout(300)

    // Count ALL video layer elements (data-preview-video-layer="true" covers
    // both the top layer with data-testid="preview-video" and any lower layers).
    const layerCount = await page.locator('[data-preview-video-layer="true"]').count()
    // We expect exactly 2 (one per video track).
    expect(layerCount).toBe(2)

    // Verify that the element with the higher layer-index has the larger zIndex.
    const zIndexes = await page.evaluate(() => {
      const layers = Array.from(
        document.querySelectorAll<HTMLElement>('[data-preview-video-layer-shell="true"]')
      )
      return layers.map((el) => ({
        layerIndex: Number(el.getAttribute('data-layer-index')),
        zIndex: Number(el.style.zIndex)
      }))
    })
    // Both should have non-negative layer-index (active clips).
    const activeLayers = zIndexes.filter((l) => l.layerIndex >= 0)
    expect(activeLayers.length).toBe(2)
    // Sort by layerIndex; the higher index must have the higher zIndex.
    activeLayers.sort((a, b) => a.layerIndex - b.layerIndex)
    expect(activeLayers[1].zIndex).toBeGreaterThan(activeLayers[0].zIndex)
  })

  // -------------------------------------------------------------------------
  // Scenario (7) — CSS transform + opacity applied to the preview <video>
  // -------------------------------------------------------------------------
  test('(7) non-identity transform applies CSS transform+opacity to preview video element', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs, 0)

    // Apply a clearly non-identity transform.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 1.5, rotation: 10, opacity: 0.4 }
      )
    }, cid)

    // Move playhead onto the clip.
    await page.evaluate((ms) => {
      const ui = (window as unknown as {
        __reelsTimelineUi: { getState: () => { setPlayheadMs: (ms: number) => void } }
      }).__reelsTimelineUi
      ui.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    // The top-most video layer carries data-testid="preview-video".
    // Since this is a single-track project, there's one active layer.
    const videoShell = page.locator('[data-preview-video-layer-shell="true"]').first()

    // CSS transform must contain scale(1.5) and rotate(10deg).
    const cssTransform = await videoShell.evaluate(
      (el) => (el as HTMLElement).style.transform
    )
    expect(cssTransform).toContain('scale(1.5)')
    expect(cssTransform).toContain('rotate(10deg)')

    // opacity must reflect 0.4.
    const cssOpacity = await videoShell.evaluate(
      (el) => (el as HTMLElement).style.opacity
    )
    const opacityNum = parseFloat(cssOpacity)
    expect(opacityNum).toBeCloseTo(0.4, 2)
  })

  test('slide 11: cropped upper video remains visible above the base video layer', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    const secondTrackId = await page.evaluate(() => {
      return (window as unknown as { __reelsStore: ReelsStore }).__reelsStore.addVideoTrack()
    })
    expect(secondTrackId).not.toBeNull()

    // "Top track = front" convention (릴스벤치19 slide 14): the cropped overlay
    // lives on track 0 (top of the timeline → FRONT); the plain base goes on the
    // second, lower track (→ BEHIND).
    await addVideoClip(mediaId, durationMs, 0, secondTrackId as string)
    const upperCid = await addVideoClip(mediaId, durationMs, 0)

    await page.evaluate((id) => {
      ;(window as unknown as {
        __PROJECT_STORE_FOR_TEST__: {
          getState: () => {
            setClipCrop: (id: string, partial: Record<string, number>) => void
            setClipTransform: (id: string, partial: Record<string, number>) => void
          }
        }
      }).__PROJECT_STORE_FOR_TEST__.getState().setClipCrop(id, {
        x: 0.18,
        y: 0.08,
        w: 0.58,
        h: 0.62
      })
      ;(window as unknown as {
        __PROJECT_STORE_FOR_TEST__: {
          getState: () => {
            setClipTransform: (id: string, partial: Record<string, number>) => void
          }
        }
      }).__PROJECT_STORE_FOR_TEST__.getState().setClipTransform(id, {
        scale: 0.82,
        x: -0.12,
        y: -0.04
      })
    }, upperCid)

    await page.evaluate((ms) => {
      const ui = (window as unknown as {
        __reelsTimelineUi: { getState: () => { setPlayheadMs: (ms: number) => void } }
      }).__reelsTimelineUi
      ui.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(400)

    const metrics = await page.evaluate((clipId) => {
      const shells = Array.from(
        document.querySelectorAll<HTMLElement>('[data-preview-video-layer-shell="true"]')
      ).map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          clipId: el.getAttribute('data-clip-id'),
          layerIndex: Number(el.getAttribute('data-layer-index')),
          zIndex: Number(el.style.zIndex),
          display: getComputedStyle(el).display,
          opacity: Number(getComputedStyle(el).opacity),
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height
        }
      })
      const upper = shells.find((s) => s.clipId === clipId) ?? null
      const active = shells.filter((s) => s.layerIndex >= 0 && s.display !== 'none')
      return { upper, active }
    }, upperCid)

    expect(metrics.active.length).toBe(2)
    expect(metrics.upper).not.toBeNull()
    const other = metrics.active.find((s) => s.clipId !== upperCid)!
    // The cropped overlay on the TOP timeline track must composite in FRONT of
    // the base (higher layerIndex → higher zIndex).
    expect(metrics.upper!.layerIndex).toBeGreaterThan(other.layerIndex)
    expect(metrics.upper!.zIndex).toBeGreaterThan(other.zIndex)
    expect(metrics.upper!.opacity).toBeGreaterThan(0.9)
    expect(metrics.upper!.area).toBeGreaterThan(1_000)
  })

  // -------------------------------------------------------------------------
  // Scenario (8) — transform-indicator badge visible / removed
  // -------------------------------------------------------------------------
  test('(8) transform-indicator badge appears when transform applied, gone after reset', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs, 0)

    // Initially there should be no transform-indicator for this clip.
    await expect(
      page.locator(`[data-testid="transform-indicator"][data-clip-id="${cid}"]`)
    ).not.toBeVisible()

    // Apply a non-identity transform.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 2 }
      )
    }, cid)
    await expect(
      page.locator(`[data-testid="transform-indicator"][data-clip-id="${cid}"]`)
    ).toBeVisible({ timeout: 4_000 })

    // Reset → badge must disappear.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.resetClipTransform(id)
    }, cid)
    await expect(
      page.locator(`[data-testid="transform-indicator"][data-clip-id="${cid}"]`)
    ).not.toBeVisible({ timeout: 4_000 })
  })

  // -------------------------------------------------------------------------
  // Scenario (9) — buildPlan with two overlapping video tracks → `overlay`
  // -------------------------------------------------------------------------
  test('(9) buildPlan with two overlapping video tracks contains overlay in filterGraph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add second video track.
    const secondTrackId = await page.evaluate(() => {
      return (window as unknown as { __reelsStore: ReelsStore }).__reelsStore.addVideoTrack()
    })
    expect(secondTrackId).not.toBeNull()

    // One clip on track 0, one on track 1 — both overlap [0, durationMs].
    await addVideoClip(mediaId, durationMs, 0)
    await addVideoClip(mediaId, durationMs, 0, secondTrackId as string)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-overlay.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
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
    // Two overlapping video tracks must produce an overlay filter.
    expect(result.filterGraph).toContain('overlay')
  })

  // -------------------------------------------------------------------------
  // Scenario (10) — non-identity transform → `rotate=` + `colorchannelmixer`
  // -------------------------------------------------------------------------
  test('(10) buildPlan non-identity transform produces rotate= and colorchannelmixer=aa= in filterGraph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs, 0)

    // Apply a transform with both rotation and reduced opacity.
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { rotation: 15, opacity: 0.7 }
      )
    }, cid)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-transform.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
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
    expect(result.filterGraph).toContain('rotate=')
    expect(result.filterGraph).toContain('colorchannelmixer=aa=')
  })

  // -------------------------------------------------------------------------
  // Scenario (11) — REGRESSION: single identity track → concat=n=2, no overlay
  // -------------------------------------------------------------------------
  test('(11) REGRESSION: single identity-transform track produces concat=n=2 and no overlay', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Two sequential clips on the single default video track — no transform.
    await addVideoClip(mediaId, durationMs, 0)
    await addVideoClip(mediaId, durationMs, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-regression.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )

    expect(result.ok).toBe(true)
    expect(result.videoSegmentCount).toBe(2)
    expect(result.filterGraph).toBeTruthy()
    // Must still produce the standard concat graph.
    expect(result.filterGraph).toContain('concat=n=2')
    expect(result.filterGraph).toContain('scale=1080:1920')
    // Regression: must NOT contain an overlay filter for a single identity track.
    // We check specifically for the layer-composite overlay (not caption overlay).
    // Layer overlays have the form "[...][...]overlay=0:0:eof_action=pass".
    expect(result.filterGraph).not.toContain('eof_action=pass')
  })

  // -------------------------------------------------------------------------
  // Scenario (12) — transitions stay intra-track: xfade once + overlay
  // -------------------------------------------------------------------------
  test('(12) intra-track xfade does not bleed to upper layer: xfade on track0, overlay for composite', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add second video track.
    const secondTrackId = await page.evaluate(() => {
      return (window as unknown as { __reelsStore: ReelsStore }).__reelsStore.addVideoTrack()
    })
    expect(secondTrackId).not.toBeNull()

    // Track 0: two sequential clips with a crossfade transition.
    const c1 = await addVideoClip(mediaId, durationMs, 0)
    const c2 = await addVideoClip(mediaId, durationMs, durationMs)
    expect(c1).toBeTruthy()
    await page.evaluate((id) => {
      const reels = (window as unknown as {
        __reelsStore: {
          setClipTransitionIn: (id: string, kind: string, dur?: number) => void
        }
      }).__reelsStore
      reels.setClipTransitionIn(id, 'crossfade', 500)
    }, c2)

    // Track 1 (upper layer): a single clip that overlaps the transition area.
    await addVideoClip(mediaId, durationMs, 0, secondTrackId as string)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-xfade-overlay.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: ReelsStore }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(
          project,
          'instagram-reels',
          outputPath
        )
      },
      { outputPath: outPath }
    )

    expect(result.ok).toBe(true)
    const graph = result.filterGraph ?? ''
    // Multi-track projects always emit the layer-composite overlay.
    expect(graph).toContain('overlay')
    // Track 0 has a crossfade: either xfade or concat fallback (same as
    // export.spec.ts — bundled ffmpeg may pre-date xfade).
    const hasXfade = graph.includes('xfade') || graph.includes('xfade=transition=fade')
    const hasConcat = graph.includes('concat=n=2')
    expect(hasXfade || hasConcat).toBe(true)
    // The xfade/concat for track 0 should appear exactly once for the intra-
    // track join; the overlay is a separate filter chain for cross-track compositing.
    // Count occurrences of "eof_action=pass" (layer-composite overlays) — must be 1.
    const eofCount = (graph.match(/eof_action=pass/g) ?? []).length
    expect(eofCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Scenario (13) — Real ffmpeg export: two overlapping tracks, scale:0.5
  // -------------------------------------------------------------------------
  test('(13) exporter:run with two overlapping video tracks (upper scale:0.5) produces valid 1080×1920 mp4', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add second video track.
    const secondTrackId = await page.evaluate(() => {
      return (window as unknown as { __reelsStore: ReelsStore }).__reelsStore.addVideoTrack()
    })
    expect(secondTrackId).not.toBeNull()

    // Base clip on track 0 — no transform.
    await addVideoClip(mediaId, durationMs, 0)

    // Upper clip on track 1 — scale 0.5 (picture-in-picture style).
    const upperCid = await addVideoClip(mediaId, durationMs, 0, secondTrackId as string)
    await page.evaluate((id) => {
      ;(window as unknown as { __reelsStore: ReelsStore }).__reelsStore.setClipTransform(
        id,
        { scale: 0.5 }
      )
    }, upperCid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `two-layer-pip-${Date.now()}.mp4`)
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
          jobId: `e2e-pip-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `export failed: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
    // 9:16 instagram-reels preset dimensions.
    if (r.width && r.height) {
      expect(r.width).toBe(1080)
      expect(r.height).toBe(1920)
    }
  })
})
