import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 4.3 — Undo/Redo (zundo middleware on the project store).
 *
 * We drive mutations through the renderer test bridge (`__reelsStore`) and
 * inspect history via `__reelsUndoRedo` (the temporal sub-store).
 *
 * Notes about timing:
 *   - The temporal middleware throttles entries to one every 200ms. Tests
 *     that need N distinct entries `sleep(220ms)` between mutations.
 *   - `createNew()` and `initProjectStore()` clear history via setTimeout(0),
 *     so we wait ~50ms after them to let the clear land.
 */
test.describe('@phase-4-undo undo/redo via zundo middleware', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      // Wait for persistence debounce AND the deferred clear() setTimeout
      // (throttle window + 50ms) inside createNew.
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

  // -------------------------------------------------------------------------
  // Helpers (mirror the helpers used in editing.spec.ts).
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
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
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
    mediaId: string
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

  async function clipExists(clipId: string): Promise<boolean> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{ clips: Array<{ id: string }> }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return true
      return false
    }, clipId)
  }

  async function getHistoryCounts(): Promise<{ past: number; future: number }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(() => {
      const t = (
        window as unknown as {
          __reelsUndoRedo: {
            getState: () => {
              pastStates: unknown[]
              futureStates: unknown[]
            }
          }
        }
      ).__reelsUndoRedo
      const s = t.getState()
      return { past: s.pastStates.length, future: s.futureStates.length }
    })
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsUndoRedo: { getState: () => { undo: () => void } }
        }
      ).__reelsUndoRedo.getState().undo()
    })
  }

  async function redo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __reelsUndoRedo: { getState: () => { redo: () => void } }
        }
      ).__reelsUndoRedo.getState().redo()
    })
  }

  /** Sleep ≥ throttle window so consecutive mutations create distinct entries. */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  // -------------------------------------------------------------------------
  // Core: add → undo → redo
  // -------------------------------------------------------------------------
  test('temporal bridge exposed on window after editor mount', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    const has = await page.evaluate(
      () =>
        typeof (
          window as unknown as {
            __reelsUndoRedo?: { getState: () => unknown }
          }
        ).__reelsUndoRedo?.getState === 'function'
    )
    expect(has).toBe(true)
  })

  test('Ctrl+Z after adding a clip removes the clip; Ctrl+Shift+Z re-adds', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    // Wait past the throttle window so the addMedia entry is captured cleanly.
    await tick()
    const clipId = await addVideoClip(durationMs, mediaId)
    // Flush throttle so the addClip becomes a distinct entry.
    await tick()

    expect(await clipExists(clipId)).toBe(true)

    // Body-level focus so Ctrl+Z reaches our window handler (not an input).
    await page.locator('[data-testid="editor-page"]').click()
    await page.keyboard.press('Control+z')
    await tick()
    expect(await clipExists(clipId)).toBe(false)

    await page.keyboard.press('Control+Shift+z')
    await tick()
    expect(await clipExists(clipId)).toBe(true)
  })

  test('redo via Ctrl+Y works as well', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    const clipId = await addVideoClip(durationMs, mediaId)
    await tick()

    await page.locator('[data-testid="editor-page"]').click()
    await page.keyboard.press('Control+z')
    await tick()
    expect(await clipExists(clipId)).toBe(false)
    await page.keyboard.press('Control+y')
    await tick()
    expect(await clipExists(clipId)).toBe(true)
  })

  test('multi-op FILO: A, B, C → undo undo undo restores order in reverse', async () => {
    if (!launched) throw new Error('launch failed')
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    const a = await addVideoClip(durationMs, mediaId)
    await tick()
    const b = await addVideoClip(durationMs, mediaId)
    await tick()
    const c = await addVideoClip(durationMs, mediaId)
    await tick()

    expect(await clipExists(a)).toBe(true)
    expect(await clipExists(b)).toBe(true)
    expect(await clipExists(c)).toBe(true)

    await undo()
    expect(await clipExists(c)).toBe(false)
    expect(await clipExists(b)).toBe(true)
    expect(await clipExists(a)).toBe(true)

    await undo()
    expect(await clipExists(b)).toBe(false)
    expect(await clipExists(a)).toBe(true)

    await undo()
    expect(await clipExists(a)).toBe(false)
  })

  test('100-entry limit: pastStates never exceeds the cap', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )
    // Bypass the 200ms throttle for this test only: we want to push 110
    // distinct entries through `_handleSet` so we can observe the cap
    // clamping at 100. zundo's `pause()` halts tracking entirely (wrong
    // tool); the right hook is `_handleSet` itself, which we call directly
    // with throwaway snapshots. The handleSet is an internal API but it is
    // documented on TemporalState and stable across the major version we
    // pinned.
    await page.evaluate(() => {
      const t = (
        window as unknown as {
          __reelsUndoRedo: {
            getState: () => {
              _handleSet: (
                past: unknown,
                replace: unknown,
                current: unknown,
                delta: unknown
              ) => void
              clear: () => void
            }
          }
        }
      ).__reelsUndoRedo.getState()
      t.clear()
      for (let i = 0; i < 110; i++) {
        // Each call appends one entry to pastStates regardless of equality.
        t._handleSet({ marker: i }, undefined, { marker: i + 1 }, null)
      }
    })
    const { past } = await getHistoryCounts()
    expect(past).toBe(100)
  })

  test('createNew() clears history (after the next-tick deferred clear)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    await addVideoClip(durationMs, mediaId)
    await tick()
    const before = await getHistoryCounts()
    expect(before.past).toBeGreaterThan(0)

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => { createNew: () => void }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
    })
    // Wait past UNDO_THROTTLE_MS + 50ms used by createNew to defer the clear.
    await page.waitForTimeout(400)
    const after = await getHistoryCounts()
    expect(after.past).toBe(0)
    expect(after.future).toBe(0)
  })

  test('caption text edit is undoable', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 5_000 }
    )

    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    await tick()

    const captionId = (await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const t = reels.state().project.tracks.find((tt) => tt.kind === 'caption')
      return t?.clips[0]?.id ?? null
    })) as string

    expect(captionId).toBeTruthy()

    // Capture the original text snapshot.
    const originalSpans = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string; spans?: unknown[] }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return JSON.stringify(c.spans)
      return null
    }, captionId)

    // Edit via the store directly to keep the test deterministic.
    await page.evaluate((cid) => {
      const store = (
        window as unknown as {
          __PROJECT_STORE_FOR_TEST__: {
            getState: () => {
              updateCaption: (
                id: string,
                p: { spans: Array<{ text: string }> }
              ) => void
            }
          }
        }
      ).__PROJECT_STORE_FOR_TEST__
      store.getState().updateCaption(cid, { spans: [{ text: 'NEW_TEXT' }] })
    }, captionId)
    await tick()

    const newSpans = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string; spans?: unknown[] }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return JSON.stringify(c.spans)
      return null
    }, captionId)
    expect(newSpans).not.toBe(originalSpans)

    await undo()
    const afterUndo = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string; spans?: unknown[] }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return JSON.stringify(c.spans)
      return null
    }, captionId)
    expect(afterUndo).toBe(originalSpans)
  })

  test('audio gain change is undoable', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    const clipId = await addVideoClip(durationMs, mediaId)
    await tick()

    await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipGainDb: (id: string, db: number) => void }
        }
      ).__reelsStore
      reels.setClipGainDb(cid, 6)
    }, clipId)
    await tick()

    const after = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{ id: string; gainDb?: number }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c.gainDb
      return null
    }, clipId)
    expect(after).toBe(6)

    await undo()
    const afterUndo = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{ id: string; gainDb?: number }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c.gainDb
      return null
    }, clipId)
    // undo should restore to undefined (the default before our set).
    expect(afterUndo).not.toBe(6)
  })

  test('speed change is undoable; endMs is restored', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    const clipId = await addVideoClip(durationMs, mediaId)
    await tick()

    const beforeEnd = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{ id: string; endMs: number }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) return c.endMs
      return null
    }, clipId)

    await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
      ).__reelsStore
      reels.setClipSpeed(cid, 2)
    }, clipId)
    await tick()

    const afterEnd = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{
                    id: string
                    endMs: number
                    speed?: number
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips)
          if (c.id === cid) return { endMs: c.endMs, speed: c.speed }
      return null
    }, clipId)
    expect(afterEnd?.speed).toBe(2)
    expect(afterEnd?.endMs).toBeLessThan(beforeEnd ?? Infinity)

    await undo()
    const undone = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{
                    id: string
                    endMs: number
                    speed?: number
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      for (const t of reels.state().project.tracks)
        for (const c of t.clips)
          if (c.id === cid) return { endMs: c.endMs, speed: c.speed }
      return null
    }, clipId)
    expect(undone?.endMs).toBe(beforeEnd)
    // Pre-speed clip didn't have a 2× speed.
    expect(undone?.speed).not.toBe(2)
  })

  test('toolbar undo/redo buttons reflect canUndo/canRedo state', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()

    // After createNew + initial empty state: undo should be disabled.
    const undoBtn = page.locator('[data-testid="undo-button"]')
    const redoBtn = page.locator('[data-testid="redo-button"]')

    // Right after open the addMedia happened — past has 1 entry → can undo.
    await tick()
    await expect(undoBtn).toHaveAttribute('data-can-undo', 'true')
    await expect(redoBtn).toHaveAttribute('data-can-redo', 'false')

    await addVideoClip(durationMs, mediaId)
    await tick()
    await expect(undoBtn).toHaveAttribute('data-can-undo', 'true')

    // Undo by clicking the button.
    await undoBtn.click()
    await tick()
    await expect(redoBtn).toHaveAttribute('data-can-redo', 'true')

    // Redo by clicking the button.
    await redoBtn.click()
    await tick()
    await expect(redoBtn).toHaveAttribute('data-can-redo', 'false')
  })

  test('throttle: rapid mutations within 200ms collapse into ≤2 history entries', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await tick()
    const clipId = await addVideoClip(durationMs, mediaId)
    await tick()

    // Snapshot the count BEFORE the burst.
    const before = await getHistoryCounts()

    // Burst: 10 rapid trim updates inside a single 200ms window — issued via
    // a tight in-page loop so no Playwright IPC latency.
    await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            updateMediaClipTrim: (
              id: string,
              partial: { startMs?: number; endMs?: number; trimOutMs?: number }
            ) => void
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{ id: string; endMs: number }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      // Find the clip's endMs to compute "shrink" values.
      let baseEnd = 0
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.id === cid) baseEnd = c.endMs
      for (let i = 0; i < 10; i++) {
        const newEnd = baseEnd - i - 1
        reels.updateMediaClipTrim(cid, { endMs: newEnd, trimOutMs: newEnd })
      }
    }, clipId)
    // Wait past throttle window so trailing-flush lands.
    await page.waitForTimeout(300)

    const after = await getHistoryCounts()
    // Leading edge captures 1, trailing-flush captures 1 → ≤2 net new entries
    // for the entire burst. Without the throttle this would be 10.
    expect(after.past - before.past).toBeLessThanOrEqual(2)
    expect(after.past - before.past).toBeGreaterThanOrEqual(1)
  })

  test('typing in caption textarea does NOT trigger undo via Ctrl+Z', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    await tick()

    const beforeHistory = await getHistoryCounts()
    const ta = page.locator('[data-testid="caption-text-input"]')
    await ta.focus()
    // Ctrl+Z while focused on the textarea should be swallowed by the
    // browser's native input undo (not our handler) — i.e. no project
    // mutation.
    await page.keyboard.press('Control+z')
    await tick()
    const afterHistory = await getHistoryCounts()
    // The textarea's local undo doesn't touch the project store, so
    // pastStates count should NOT have decreased.
    expect(afterHistory.past).toBeGreaterThanOrEqual(beforeHistory.past)
  })
})
