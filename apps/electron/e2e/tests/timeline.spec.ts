import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2.2 timeline + preview + transport E2E.
 *
 * We use page.evaluate() against the project store + timeline UI store to
 * drive interactions deterministically (drag-drop in Playwright + Electron's
 * sandbox is flaky for HTML5 DnD with custom MIME types). The store actions
 * exercised here are the same code paths the UI handlers call.
 */
test.describe('@phase-2-timeline timeline + preview + transport', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
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

  async function importFixtureAndOpenEditor(): Promise<{
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

    // Reset to a fresh project — guarantees video+audio tracks exist.
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: { createNew: () => void }
      }
      w.__reelsStore.createNew()
    })

    // Import via the same path the renderer uses (probe + thumb + addMedia).
    const result = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const win = window as unknown as {
        __reelsTestAddMedia?: (asset: unknown) => void
      }
      // Pull store via module side-effects: dynamic import is not available
      // in the renderer here, so we round-trip through a tiny script the
      // renderer exposes (added in Phase 2.2 only if needed). Instead, we
      // use a known global the store exports for tests if present; otherwise
      // dispatch a synthetic addMedia via window.__reelsStore.
      const reelsStore = (window as unknown as {
        __reelsStore?: { addMedia: (asset: unknown) => void; newId: () => string }
      }).__reelsStore
      if (!reelsStore) {
        throw new Error('test bridge __reelsStore not exposed')
      }
      const id = reelsStore.newId()
      reelsStore.addMedia({
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
      void win
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
    return result
  }

  async function resetProject(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: { createNew: () => void }
      }
      w.__reelsStore.createNew()
    })
  }

  test('preview area, timeline, and transport mount', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await resetProject()

    await expect(page.locator('[data-testid="preview-area"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport"]')).toBeVisible()
    await expect(page.locator('[data-testid="transport-play"]')).toBeVisible()
    await expect(page.locator('[data-testid="track-lane-video"]')).toBeVisible()
    await expect(page.locator('[data-testid="track-lane-audio"]')).toBeVisible()
  })

  test('clicking ruler moves playhead and updates UI store', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await resetProject()

    const ruler = page.locator('[data-testid="timeline-ruler"]')
    const box = await ruler.boundingBox()
    if (!box) throw new Error('ruler bbox missing')
    // Click ~200px in from left edge — lane label takes 64px, so ~136px
    // worth of timeline content, at 50pps default that's ~2.72s.
    const clickX = box.x + 200
    const clickY = box.y + box.height / 2
    await page.mouse.click(clickX, clickY)

    const playhead = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi?: { getState: () => { playheadMs: number } }
      }
      return w.__reelsTimelineUi?.getState().playheadMs ?? -1
    })
    // The exact value depends on layout, but it must be > 0.
    expect(playhead).toBeGreaterThan(500)
    expect(playhead).toBeLessThan(10_000)
  })

  test('space toggles playing state', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
    await page.locator('[data-testid="open-editor-button"]').click()
    await resetProject()
    // Make sure focus is on body, not the project-name input.
    await page.locator('[data-testid="timeline"]').click()

    const before = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi?: { getState: () => { playing: boolean } }
      }
      return w.__reelsTimelineUi?.getState().playing ?? null
    })
    expect(before).toBe(false)

    await page.keyboard.press('Space')

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi?: { getState: () => { playing: boolean } }
      }
      return w.__reelsTimelineUi?.getState().playing ?? null
    })
    expect(after).toBe(true)

    // Toggle back so the rAF loop doesn't keep ticking past the test.
    await page.keyboard.press('Space')
  })

  test('addClip creates a timeline clip; total duration matches media', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixtureAndOpenEditor()

    await page.evaluate(({ mediaId: id }) => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: { tracks: Array<{ id: string; kind: string; clips: unknown[] }> }
          }
          addClip: (clip: unknown) => void
          newId: () => string
        }
      }
      const project = w.__reelsStore.state().project
      const videoTrack = project.tracks.find((t) => t.kind === 'video')
      if (!videoTrack) throw new Error('no video track')
      const dur =
        (project as unknown as { media: Record<string, { durationMs: number }> })
          .media[id].durationMs
      w.__reelsStore.addClip({
        id: w.__reelsStore.newId(),
        mediaId: id,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: 0
      })
    }, { mediaId })

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(1)

    const total = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{ clips: Array<{ endMs: number }> }>
            }
          }
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      let max = 0
      for (const t of tracks) for (const c of t.clips) if (c.endMs > max) max = c.endMs
      return max
    })
    expect(total).toBe(durationMs)
  })

  test('updateClip moves clip startMs (simulates drag)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixtureAndOpenEditor()

    const clipId = await page.evaluate(({ mediaId: id, dur }) => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => { project: { tracks: Array<{ id: string; kind: string }> } }
          addClip: (clip: unknown) => void
          newId: () => string
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      const videoTrack = tracks.find((t) => t.kind === 'video')
      if (!videoTrack) throw new Error('no video track')
      const cid = w.__reelsStore.newId()
      w.__reelsStore.addClip({
        id: cid,
        mediaId: id,
        trackId: videoTrack.id,
        startMs: 0,
        endMs: dur,
        trimInMs: 0,
        trimOutMs: 0
      })
      return cid
    }, { mediaId, dur: durationMs })

    await page.evaluate(({ clipId: cid, dur }) => {
      const w = window as unknown as {
        __reelsStore: { updateClip: (id: string, partial: unknown) => void }
      }
      w.__reelsStore.updateClip(cid, { startMs: 3000, endMs: 3000 + dur })
    }, { clipId, dur: durationMs })

    const moved = await page.evaluate(({ clipId: cid }) => {
      const w = window as unknown as {
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
      const tracks = w.__reelsStore.state().project.tracks
      for (const t of tracks)
        for (const c of t.clips) if (c.id === cid)
          return { startMs: c.startMs, endMs: c.endMs }
      return null
    }, { clipId })
    expect(moved).toEqual({ startMs: 3000, endMs: 3000 + durationMs })
  })

  test('drag from MediaLibrary creates a clip on the matching track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await importFixtureAndOpenEditor()

    // The MediaCard now has draggable=true. We simulate the drag by directly
    // constructing the dataTransfer and dispatching dragover/drop on the
    // video track lane — this exercises the same handler the real DnD uses.
    await page.evaluate(({ mediaId: id }) => {
      const card = document.querySelector(
        `[data-testid="media-card"][data-media-id="${id}"]`
      ) as HTMLElement | null
      const lane = document.querySelector(
        '[data-testid="track-drop-video"]'
      ) as HTMLElement | null
      if (!card || !lane) throw new Error('card or lane missing')
      const dt = new DataTransfer()
      dt.setData('application/x-reels-media-id', id)
      dt.setData('text/plain', id)
      const laneRect = lane.getBoundingClientRect()
      // Drop at ~150px into the lane.
      const clientX = laneRect.left + 150
      const clientY = laneRect.top + laneRect.height / 2
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
    }, { mediaId })

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(1)

    const clipInfo = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{
                kind: string
                clips: Array<{ startMs: number; endMs: number; mediaId: string }>
              }>
            }
          }
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      for (const t of tracks)
        for (const c of t.clips) return { kind: t.kind, ...c }
      return null
    })
    expect(clipInfo?.kind).toBe('video')
    expect(clipInfo?.endMs).toBeLessThanOrEqual(durationMs + 10_000)
    expect(clipInfo?.endMs - (clipInfo?.startMs ?? 0)).toBe(durationMs)
  })
})
