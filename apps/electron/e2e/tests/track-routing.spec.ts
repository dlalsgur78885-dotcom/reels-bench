import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2 — audio/video track routing regression suite.
 *
 * Verifies the slide-10 fix:
 *   - media.ts `parseProbe()` classifies mp3 (even with embedded cover-art) as
 *     kind='audio', not 'video'.
 *   - project.ts `ensureAudioTrack()` auto-creates a Voice track when the
 *     project has none.
 *   - Timeline.tsx `handleLaneDrop()` routes audio media to audio tracks and
 *     video media to video tracks, regardless of which lane the cursor is over.
 *
 * We drive drops via synthetic DragEvent on the lane element (same as the
 * existing timeline.spec.ts pattern) so the real handler code executes.
 */
test.describe('@phase-2-track-routing audio/video track drop routing', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    // Reset to a clean project before each test.
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

  // ---------------------------------------------------------------------------
  // Helper: open editor and register a media asset in the store.
  // ---------------------------------------------------------------------------
  async function registerMedia(
    filePath: string
  ): Promise<{ mediaId: string; kind: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    await page.locator('[data-testid="open-editor-button"]').click()
    await expect(page.locator('[data-testid="editor-page"]')).toBeVisible()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    return await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      const probe = await window.electron.media.probe(fp)
      const fileName = fp.split(/[/\\]/).pop() ?? fp
      const reels = (
        window as unknown as {
          __reelsStore: {
            addMedia: (a: unknown) => void
            newId: () => string
          }
        }
      ).__reelsStore
      const id = reels.newId()
      reels.addMedia({
        id,
        path: fp,
        kind: probe.kind,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return { mediaId: id, kind: probe.kind, durationMs: probe.durationMs }
    }, filePath)
  }

  // ---------------------------------------------------------------------------
  // Helper: simulate a drop of a registered media id onto a lane by kind.
  // Returns { trackKind, trackRole } of the track where the clip landed.
  // ---------------------------------------------------------------------------
  async function dropOnLane(
    mediaId: string,
    laneSelector: string
  ): Promise<{ trackKind: string; trackRole?: string } | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched

    return await page.evaluate(
      ({ id, selector }) => {
        const lane = document.querySelector(selector) as HTMLElement | null
        if (!lane) return null
        const dt = new DataTransfer()
        dt.setData('application/x-reels-media-id', id)
        dt.setData('text/plain', id)
        const rect = lane.getBoundingClientRect()
        const clientX = rect.left + 80
        const clientY = rect.top + rect.height / 2
        lane.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt })
        )
        lane.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: dt })
        )
        // Read back which track holds the new clip.
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{
                    id: string
                    kind: string
                    role?: string
                    clips: Array<{ mediaId: string }>
                  }>
                }
              }
            }
          }
        ).__reelsStore
        for (const t of reels.state().project.tracks) {
          if (t.clips.some((c) => c.mediaId === id)) {
            return { trackKind: t.kind, trackRole: t.role }
          }
        }
        return null
      },
      { id: mediaId, selector: laneSelector }
    )
  }

  // ---------------------------------------------------------------------------
  // 1. IPC probe classifies mp3 as kind='audio' (cover-art guard).
  // ---------------------------------------------------------------------------
  test('probe: mp3 file is classified as kind=audio, not video', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP3
    if (!fixture) throw new Error('E2E_FIXTURE_MP3 not set — globalSetup failed')

    const probed = await page.evaluate(async (fp: string) => {
      await window.electron.fs.allowPath(fp)
      return await window.electron.media.probe(fp)
    }, fixture)

    expect(probed.kind).toBe('audio')
    // Audio files have no video dimensions.
    expect(probed.width).toBe(0)
    expect(probed.height).toBe(0)
    expect(probed.durationMs).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // 2. Dropping audio media onto a video lane → clip lands on an audio track.
  // ---------------------------------------------------------------------------
  test('audio media dropped on video lane lands on an audio track, not video', async () => {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP3
    if (!fixture) throw new Error('E2E_FIXTURE_MP3 not set — globalSetup failed')

    const { mediaId, kind } = await registerMedia(fixture)
    expect(kind).toBe('audio')

    // Drop on the video lane — the handler must re-route to audio.
    const result = await dropOnLane(mediaId, '[data-testid="track-lane-video"]')
    expect(result).not.toBeNull()
    expect(result!.trackKind).toBe('audio')
  })

  // ---------------------------------------------------------------------------
  // 3. Dropping audio media when no audio track exists → ensureAudioTrack
  //    auto-creates one; clip lands there.
  // ---------------------------------------------------------------------------
  test('ensureAudioTrack: audio drop on empty project creates an audio track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const fixture = process.env.E2E_FIXTURE_MP3
    if (!fixture) throw new Error('E2E_FIXTURE_MP3 not set — globalSetup failed')

    const { mediaId } = await registerMedia(fixture)

    // Remove all audio tracks so the project has none.
    await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string }> }
            }
          }
        }
      ).__reelsStore
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            setState: (fn: (s: unknown) => unknown) => void
            getState: () => {
              project: { tracks: unknown[] }
              setProject?: (p: unknown) => void
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      const current = reels.state().project
      const withoutAudio = {
        ...current,
        tracks: current.tracks.filter((t) => t.kind !== 'audio')
      }
      store.setState((s: unknown) => ({
        ...(s as object),
        project: withoutAudio
      }))
    })

    // Confirm zero audio tracks.
    const audioBefore = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ kind: string }> }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.tracks.filter((t) => t.kind === 'audio').length
    })
    expect(audioBefore).toBe(0)

    // Drop on the video lane — ensureAudioTrack should fire and create one.
    const result = await dropOnLane(mediaId, '[data-testid="track-lane-video"]')
    expect(result).not.toBeNull()
    expect(result!.trackKind).toBe('audio')

    // Confirm a new audio track was created.
    const audioAfter = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ kind: string }> }
            }
          }
        }
      ).__reelsStore
      return reels.state().project.tracks.filter((t) => t.kind === 'audio').length
    })
    expect(audioAfter).toBeGreaterThanOrEqual(1)
  })

  // ---------------------------------------------------------------------------
  // 4. Regression: video media dropped on video lane still lands on video track.
  // ---------------------------------------------------------------------------
  test('regression: video media dropped on video lane still lands on a video track', async () => {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

    const { mediaId, kind } = await registerMedia(fixture)
    expect(kind).toBe('video')

    const result = await dropOnLane(mediaId, '[data-testid="track-lane-video"]')
    expect(result).not.toBeNull()
    expect(result!.trackKind).toBe('video')
  })

  // ---------------------------------------------------------------------------
  // 5. Regression: video media dropped on audio lane is re-routed to video track.
  // ---------------------------------------------------------------------------
  test('regression: video media dropped on audio lane is re-routed to a video track', async () => {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')

    const { mediaId, kind } = await registerMedia(fixture)
    expect(kind).toBe('video')

    // Drop on the first audio lane — should still land on the video track.
    const result = await dropOnLane(mediaId, '[data-testid="track-lane-audio"]')
    expect(result).not.toBeNull()
    expect(result!.trackKind).toBe('video')
  })

  // ---------------------------------------------------------------------------
  // 6. Audio media dropped directly on an audio lane stays on that audio lane.
  // ---------------------------------------------------------------------------
  test('audio media dropped directly on an audio lane stays on that audio track', async () => {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP3
    if (!fixture) throw new Error('E2E_FIXTURE_MP3 not set — globalSetup failed')

    const { mediaId, kind } = await registerMedia(fixture)
    expect(kind).toBe('audio')

    const result = await dropOnLane(mediaId, '[data-testid="track-lane-audio"]')
    expect(result).not.toBeNull()
    expect(result!.trackKind).toBe('audio')
  })
})
