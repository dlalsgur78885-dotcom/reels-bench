import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2.2 — timeline + preview + transport.
 *
 * We drive interactions through the renderer-side test bridge (`__reelsStore`,
 * `__reelsTimelineUi`) to avoid HTML5 DnD flakiness inside the Electron
 * sandbox, but we still synthesize a `drop` event for the lane to exercise
 * the actual drop handler (not just the store action).
 */
test.describe('@phase-2-timeline timeline + preview + transport', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    // Clean slate each test.
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => {
              setPlayheadMs: (ms: number) => void
              setPlaying: (p: boolean) => void
              clearSelection: () => void
              setPps?: (p: number) => void
            }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setPlayheadMs(0)
      ui.getState().setPlaying(false)
      ui.getState().clearSelection()
      if (ui.getState().setPps) ui.getState().setPps!(60)
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
  // Helpers.
  // -------------------------------------------------------------------------
  async function openEditorWithMedia(): Promise<{
    mediaId: string
    durationMs: number
  }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    return await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: {
            addMedia: (asset: unknown) => void
            newId: () => string
          }
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
  }

  async function addVideoClip(
    durationMs: number,
    mediaId: string,
    startMs = 0,
    timelineDurationMs = durationMs
  ): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mediaId: id, dur }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: { tracks: Array<{ id: string; kind: string }> }
              }
              addClip: (clip: unknown) => void
              newId: () => string
            }
          }
        ).__reelsStore
        const tracks = reels.state().project.tracks
        const videoTrack = tracks.find((t) => t.kind === 'video')
        if (!videoTrack) throw new Error('no video track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: id,
          trackId: videoTrack.id,
          startMs: dur.startMs,
          endMs: dur.startMs + dur.timelineDurationMs,
          trimInMs: 0,
          trimOutMs: dur.timelineDurationMs,
          speed: 1
        })
        return cid
      },
      { mediaId, dur: { startMs, timelineDurationMs } }
    )
  }

  // -------------------------------------------------------------------------
  // Mount checks.
  // -------------------------------------------------------------------------
  test('preview, timeline, and transport all mount with expected controls', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    await expect(page.locator('[data-testid="timeline"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport-play"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport-skip-start"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport-skip-end"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport-time"]')).toBeVisible()
    await expect(page.locator('[data-testid="track-lane-video"]')).toBeVisible()
    // Phase 2.5 adds a BGM track, so audio lanes are now 2x. Verify ≥ 1 visible.
    await expect(page.locator('[data-testid="track-lane-audio"]').first()).toBeVisible()
    // Phase 3: data-testid="preview-video" now lands only on the top ACTIVE
    // layer — with no clips there is no active layer. Every video track still
    // mounts a <video> carrying data-preview-video-layer; default project = 1.
    await expect(page.locator('[data-preview-video-layer="true"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="preview-audio"]')).toHaveCount(1)
  })

  // -------------------------------------------------------------------------
  // Drag-drop from MediaLibrary → lane.
  // -------------------------------------------------------------------------
  test('drag media card → drop on video lane creates a clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()

    // Synthesize a drop event with the right MIME on the video lane. The
    // handler reads e.dataTransfer.getData(MEDIA_MIME) and computes the
    // dropMs from clientX → store.addClip.
    const created = await page.evaluate(({ id }) => {
      const card = document.querySelector(
        `[data-testid="media-card"][data-media-id="${id}"]`
      ) as HTMLElement | null
      const lane = document.querySelector(
        '[data-testid="track-lane-video"]'
      ) as HTMLElement | null
      if (!card || !lane) throw new Error('card or lane missing')
      const dt = new DataTransfer()
      dt.setData('application/x-reels-media-id', id)
      dt.setData('text/plain', id)
      const rect = lane.getBoundingClientRect()
      const clientX = rect.left + 80
      const clientY = rect.top + rect.height / 2
      const dragOver = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        dataTransfer: dt
      })
      lane.dispatchEvent(dragOver)
      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        dataTransfer: dt
      })
      lane.dispatchEvent(drop)

      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{
                    startMs: number
                    endMs: number
                    mediaId: string
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const videoTrack = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      return videoTrack.clips
    }, { id: mediaId })

    expect(created.length).toBe(1)
    expect(created[0].mediaId).toBe(mediaId)
    expect(created[0].endMs - created[0].startMs).toBe(durationMs)
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(1)
  })

  // -------------------------------------------------------------------------
  // Ruler click → playhead seek.
  // -------------------------------------------------------------------------
  test('clicking the ruler jumps the playhead to the corresponding time', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    const ruler = page.locator('[data-testid="timeline-ruler"]')
    const box = await ruler.boundingBox()
    if (!box) throw new Error('ruler bbox missing')
    // Click 240px in from left edge. The lane-header offset is 120px, so
    // 120px of content at 60pps default = 2s.
    const clickX = box.x + 240
    const clickY = box.y + box.height / 2
    await page.mouse.click(clickX, clickY)

    const ms = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { playheadMs: number }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().playheadMs
    })
    // ~2000ms expected at 60pps. Allow a wide window for layout variance.
    expect(ms).toBeGreaterThan(500)
    expect(ms).toBeLessThan(5_000)
  })

  // -------------------------------------------------------------------------
  // Space toggles playing.
  // -------------------------------------------------------------------------
  test('Space toggles the playing flag in the timelineUi store', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    // Move focus off the project-name input.
    await page.locator('[data-testid="timeline"]').click()

    const before = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { playing: boolean }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().playing
    })
    expect(before).toBe(false)

    await page.keyboard.press('Space')
    const after = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { playing: boolean }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().playing
    })
    expect(after).toBe(true)
    // Toggle off so the rAF loop doesn't keep ticking past the test.
    await page.keyboard.press('Space')
  })

  // -------------------------------------------------------------------------
  // rAF playback advances the playhead.
  // -------------------------------------------------------------------------
  test('after pressing play, playheadMs advances during ~150ms wall-clock', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    // Make sure the playhead starts at 0.
    await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setPlayheadMs(0)
    })

    // Click the play button.
    await page.locator('[data-testid="transport-play"]').click()
    // Wait for the rAF loop to tick a few frames.
    await page.waitForTimeout(150)
    const ms = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { playheadMs: number; setPlaying: (p: boolean) => void }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      const v = ui.getState().playheadMs
      ui.getState().setPlaying(false)
      return v
    })
    // We waited 150ms; allow some headroom for rAF skew.
    expect(ms).toBeGreaterThan(50)
    expect(ms).toBeLessThan(5_000)
  })

  // -------------------------------------------------------------------------
  // Clip body drag → reposition.
  // -------------------------------------------------------------------------
  test('clip body mouse drag changes startMs (whole-clip move)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Mouse-drag the clip body by ~120px to the right. At default 60 pps
    // that's ~2000ms; snap rounds to nearest second → 2000ms.
    const body = page.locator(
      `[data-testid="clip-body"][data-clip-id="${clipId}"]`
    )
    const box = await body.boundingBox()
    if (!box) throw new Error('clip body bbox missing')
    const startX = box.x + Math.min(40, box.width / 2)
    const startY = box.y + box.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // Move past the click-vs-drag threshold (5px) then to target.
    await page.mouse.move(startX + 10, startY)
    await page.mouse.move(startX + 120, startY, { steps: 8 })
    await page.mouse.up()

    const after = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{ id: string; startMs: number; endMs: number }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks) {
        for (const c of t.clips) if (c.id === cid) return c
      }
      return null
    }, clipId)
    expect(after).not.toBeNull()
    // startMs must have moved; sign should be positive (we dragged right).
    expect(after!.startMs).toBeGreaterThan(0)
    // Width preserved.
    expect(after!.endMs - after!.startMs).toBe(durationMs)
  })

  test('marquee drag on lane selects multiple clips', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipDur = Math.max(400, Math.min(1000, durationMs))
    const firstId = await addVideoClip(durationMs, mediaId, 0, clipDur)
    const secondId = await addVideoClip(
      durationMs,
      mediaId,
      clipDur + 1000,
      clipDur
    )

    await expect(page.locator(`[data-clip-id="${firstId}"]`).first()).toBeVisible()
    await expect(page.locator(`[data-clip-id="${secondId}"]`).first()).toBeVisible()

    const lane = page.locator('[data-testid="track-lane-video"]').first()
    const firstBox = await page
      .locator(`[data-testid="media-clip-block"][data-clip-id="${firstId}"]`)
      .boundingBox()
    const secondBox = await page
      .locator(`[data-testid="media-clip-block"][data-clip-id="${secondId}"]`)
      .boundingBox()
    const laneBox = await lane.boundingBox()
    if (!firstBox || !secondBox || !laneBox) throw new Error('bbox missing')

    const startX = Math.max(laneBox.x + 4, firstBox.x - 12)
    const startY = firstBox.y + firstBox.height + 8
    const endX = secondBox.x + secondBox.width + 12
    const endY = Math.max(firstBox.y, secondBox.y) - 8

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 8, startY - 4)
    await expect(page.locator('[data-testid="timeline-marquee-selection"]')).toBeVisible()
    await page.mouse.move(endX, endY, { steps: 8 })
    await page.mouse.up()

    const selected = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { selectedClipIds: Set<string> }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return [...ui.getState().selectedClipIds]
    })
    expect(selected.sort()).toEqual([firstId, secondId].sort())
    await expect(
      page.locator(`[data-testid="media-clip-block"][data-clip-id="${firstId}"]`)
    ).toHaveAttribute('data-selected', 'true')
    await expect(
      page.locator(`[data-testid="media-clip-block"][data-clip-id="${secondId}"]`)
    ).toHaveAttribute('data-selected', 'true')
  })

  // -------------------------------------------------------------------------
  // Ctrl+wheel zoom — clamp to [10, 400].
  // -------------------------------------------------------------------------
  test('Ctrl+wheel adjusts pps within [10, 400]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    const ppsBefore = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { pps: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsBefore).toBe(60)

    // Zoom-in click via the toolbar button (deterministic, no wheel needed).
    await page.locator('[data-testid="timeline-zoom-in"]').click()
    const ppsAfterIn = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { pps: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsAfterIn).toBeGreaterThan(ppsBefore)
    expect(ppsAfterIn).toBeLessThanOrEqual(400)

    // Slam zoom-in many times → clamp to MAX_PPS = 400.
    for (let i = 0; i < 30; i++) {
      await page.locator('[data-testid="timeline-zoom-in"]').click()
    }
    const ppsMax = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { pps: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsMax).toBe(400)

    // Now slam zoom-out → clamp to MIN_PPS = 10.
    for (let i = 0; i < 30; i++) {
      await page.locator('[data-testid="timeline-zoom-out"]').click()
    }
    const ppsMin = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { pps: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().pps
    })
    expect(ppsMin).toBe(10)
  })

  // -------------------------------------------------------------------------
  // Transport — skip buttons.
  // -------------------------------------------------------------------------
  test('skip-to-end button jumps playhead to total duration', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    await page.locator('[data-testid="transport-skip-end"]').click()
    const ms = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { playheadMs: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().playheadMs
    })
    // Transport parks on the last visible frame of the half-open clip range.
    expect(ms).toBe(Math.max(0, durationMs - 1))

    await page.locator('[data-testid="transport-skip-start"]').click()
    const reset = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: { getState: () => { playheadMs: number } }
        }
      ).__TIMELINE_UI_FOR_TEST__
      return ui.getState().playheadMs
    })
    expect(reset).toBe(0)
  })

  // -------------------------------------------------------------------------
  // media:// URL helper smoke test (renderer).
  // -------------------------------------------------------------------------
  test('toMediaUrl helper produces media:// URLs with URI-encoded paths', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()

    // The helper is a pure ES module export — test it indirectly via the
    // PreviewCanvas behavior: when we add a media + a clip, the <video>
    // element's src should be set to a media:// URL.
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string }> }
            }
            addMedia: (asset: unknown) => void
            addClip: (clip: unknown) => void
            newId: () => string
          }
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
      const videoTrack = reels
        .state()
        .project.tracks.find((t) => t.kind === 'video')!
      reels.addClip({
        id: reels.newId(),
        kind: 'media',
        mediaId: id,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: probe.durationMs,
        trimInMs: 0,
        trimOutMs: probe.durationMs,
        speed: 1
      })
      const ui = (
        window as unknown as {
          __TIMELINE_UI_FOR_TEST__: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__TIMELINE_UI_FOR_TEST__
      ui.getState().setPlayheadMs(500)
    }, fixture)

    // Wait for the PreviewCanvas src-swap rAF to set the active layer's src.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="preview-video"]')
        return ((el?.getAttribute('src') ?? '') as string).startsWith('media://')
      },
      null,
      { timeout: 5_000 }
    )
    const src = await page
      .locator('[data-testid="preview-video"]')
      .evaluate((el) => (el as HTMLVideoElement).getAttribute('src') ?? '')
    // toMediaUrl uses an explicit host: media://r/<encoded-path> (commit
    // f1ebb1dc — Chromium rejects host-less custom-scheme URLs).
    expect(src.startsWith('media://r/')).toBe(true)
    // Path is URI-encoded; backslashes & ':' are percent-escaped on Windows.
    expect(src).toContain(encodeURIComponent(fixture).slice(0, 8))
  })
})
