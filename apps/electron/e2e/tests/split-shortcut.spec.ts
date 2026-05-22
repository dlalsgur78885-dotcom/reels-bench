import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 4 — Ctrl/Cmd+B split shortcut (CapCut standard).
 *
 * Verifies:
 *   1. Ctrl+B splits the selected media clip at the playhead position.
 *   2. The input-field guard prevents Ctrl+B from splitting when an input has focus.
 *   3. Ctrl+B is a no-op (no crash) when no clip is selected.
 *   4. Regression: the legacy 'S' key split still works.
 *
 * Keyboard events are dispatched via Playwright's page.keyboard so the full
 * Editor.tsx keydown handler runs (same pattern as the Ctrl+D duplicate test
 * in editing.spec.ts).
 */
test.describe('@phase-4 Ctrl+B split shortcut', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched

    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })

    // Clean slate.
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
  // Helpers (mirror editing.spec.ts helpers exactly)
  // ---------------------------------------------------------------------------

  async function openEditorWithMedia(): Promise<{ mediaId: string; durationMs: number }> {
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

  async function addVideoClip(durationMs: number, mediaId: string): Promise<string> {
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
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mediaId, dur: durationMs }
    )
  }

  /** Select a clip via the timeline UI store (same path the keydown handler reads). */
  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate((cid) => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { selectClip: (id: string) => void }
          }
        }
      ).__reelsTimelineUi
        .getState()
        .selectClip(cid)
    }, clipId)
  }

  /** Set the playhead position via the timeline UI store. */
  async function setPlayhead(ms: number): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate((t) => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
      ).__reelsTimelineUi
        .getState()
        .setPlayheadMs(t)
    }, ms)
  }

  // ---------------------------------------------------------------------------
  // Test 1 — Ctrl+B splits the selected media clip at the playhead
  // ---------------------------------------------------------------------------
  test('Ctrl+B splits selected media clip at playhead into two clips', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Place playhead in the middle (well inside both ≥100ms margins).
    const splitAt = Math.floor(durationMs / 2)
    await setPlayhead(splitAt)

    // Select the clip by clicking its body, then press Ctrl+B.
    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()
    await page.keyboard.press('Control+b')

    // Expect two media-clip blocks in the timeline.
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(2)

    // Verify clip geometry via the store.
    const clips = await page.evaluate(
      ({ cid, at }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{
                    clips: Array<{
                      id: string
                      startMs: number
                      endMs: number
                      trimInMs?: number
                      trimOutMs?: number
                    }>
                  }>
                }
              }
            }
          }
        ).__reelsStore
        const all: Array<{ id: string; startMs: number; endMs: number }> = []
        for (const t of reels.state().project.tracks)
          for (const c of t.clips) all.push({ id: c.id, startMs: c.startMs, endMs: c.endMs })

        const left = all.find((c) => c.id === cid) ?? null
        const right = all.find((c) => c.id !== cid && c.startMs === at) ?? null
        return { left, right }
      },
      { cid: clipId, at: splitAt }
    )

    expect(clips.left).not.toBeNull()
    expect(clips.right).not.toBeNull()
    expect(clips.left?.startMs).toBe(0)
    expect(clips.left?.endMs).toBe(splitAt)
    expect(clips.right?.startMs).toBe(splitAt)
    expect(clips.right?.endMs).toBe(durationMs)
  })

  // ---------------------------------------------------------------------------
  // Test 2 — Input-field guard: Ctrl+B must NOT split when an input has focus
  // ---------------------------------------------------------------------------
  test('Ctrl+B is ignored when an input field has focus', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const splitAt = Math.floor(durationMs / 2)
    await setPlayhead(splitAt)
    await selectClip(clipId)

    // Focus the project-name input (an <input> element that lives in the editor topbar).
    await page.locator('[data-testid="project-name-input"]').focus()

    // Press Ctrl+B while the input is focused — the guard must swallow it.
    await page.keyboard.press('Control+b')

    // Clip count must remain 1.
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(1)
  })

  // ---------------------------------------------------------------------------
  // Test 3 — No clip selected: Ctrl+B must be a no-op (no crash)
  // ---------------------------------------------------------------------------
  test('Ctrl+B with no clip selected is a silent no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    // Ensure nothing is selected.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { clearSelection: () => void }
          }
        }
      ).__reelsTimelineUi
        .getState()
        .clearSelection()
    })

    await setPlayhead(Math.floor(durationMs / 2))

    // Press Ctrl+B — should not crash and should not split.
    await page.keyboard.press('Control+b')

    // Still one clip, no renderer error.
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(1)
    expect(launched.pageErrors).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Test 4 — Regression: legacy 'S' key split still works
  // ---------------------------------------------------------------------------
  test('S key still splits selected media clip at playhead (regression)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const splitAt = Math.floor(durationMs / 2)
    await setPlayhead(splitAt)

    // Select via click on clip body.
    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()

    // Press bare 'S' (no modifier).
    await page.keyboard.press('s')

    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(2)
  })
})
