import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2.3 — core editing ops E2E.
 *
 * Like Phase 2.2, we drive the store/UI deterministically through the
 * window-side test bridge to avoid HTML5 DnD flakiness inside the Electron
 * sandbox.
 */
test.describe('@phase-2-editing core editing ops', () => {
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
    await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: { createNew: () => void }
      }
      w.__reelsStore.createNew()
    })

    const result = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reelsStore = (window as unknown as {
        __reelsStore?: { addMedia: (asset: unknown) => void; newId: () => string }
      }).__reelsStore
      if (!reelsStore) throw new Error('test bridge __reelsStore not exposed')
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
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
    return result
  }

  async function addVideoClip(durationMs: number, mediaId: string): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mediaId: id, dur }) => {
        const w = window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ id: string; kind: string }> }
            }
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
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mediaId, dur: durationMs }
    )
  }

  async function getClip(clipId: string): Promise<{
    startMs: number
    endMs: number
    trimInMs: number
    trimOutMs: number
    speed?: number
  } | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate((cid) => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: {
              tracks: Array<{
                clips: Array<{
                  id: string
                  startMs: number
                  endMs: number
                  trimInMs: number
                  trimOutMs: number
                  speed?: number
                }>
              }>
            }
          }
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      for (const t of tracks)
        for (const c of t.clips)
          if (c.id === cid)
            return {
              startMs: c.startMs,
              endMs: c.endMs,
              trimInMs: c.trimInMs,
              trimOutMs: c.trimOutMs,
              speed: c.speed
            }
      return null
    }, clipId)
  }

  // -------------------------------------------------------------------------
  test('trim left handle increases trimInMs and shrinks clip from left', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Directly invoke the same action a real trim drag would perform.
    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { updateClip: (id: string, partial: unknown) => void }
        }
        w.__reelsStore.updateClip(cid, {
          startMs: 1000,
          trimInMs: 1000
        })
      },
      { cid: clipId }
    )

    const after = await getClip(clipId)
    expect(after).not.toBeNull()
    expect(after?.startMs).toBe(1000)
    expect(after?.trimInMs).toBe(1000)
    // endMs unchanged
    expect(after?.endMs).toBe(durationMs)
    expect((after?.endMs ?? 0) - (after?.startMs ?? 0)).toBe(durationMs - 1000)
  })

  test('trim right handle decreases trimOutMs and shrinks clip from right', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const newEnd = durationMs - 1000
    await page.evaluate(
      ({ cid, end }) => {
        const w = window as unknown as {
          __reelsStore: { updateClip: (id: string, partial: unknown) => void }
        }
        w.__reelsStore.updateClip(cid, {
          endMs: end,
          trimOutMs: end
        })
      },
      { cid: clipId, end: newEnd }
    )

    const after = await getClip(clipId)
    expect(after?.endMs).toBe(newEnd)
    expect(after?.trimOutMs).toBe(newEnd)
    expect(after?.startMs).toBe(0)
  })

  test('trim handles render with col-resize cursor and proper testids', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    await expect(page.locator('[data-testid="trim-handle-left"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="trim-handle-right"]')).toHaveCount(1)
    const cursor = await page
      .locator('[data-testid="trim-handle-left"]')
      .evaluate((el) => getComputedStyle(el).cursor)
    expect(cursor).toBe('col-resize')
  })

  test('splitClipAt produces two clips with chained trim points', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const splitAt = Math.floor(durationMs / 2)
    const rightId = await page.evaluate(
      ({ cid, ms }) => {
        const w = window as unknown as {
          __reelsStore: {
            splitClipAt: (id: string, atMs: number) => string | null
          }
        }
        return w.__reelsStore.splitClipAt(cid, ms)
      },
      { cid: clipId, ms: splitAt }
    )
    expect(rightId).not.toBeNull()

    const left = await getClip(clipId)
    const right = await getClip(rightId as string)
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()

    expect(left?.startMs).toBe(0)
    expect(left?.endMs).toBe(splitAt)
    expect(left?.trimInMs).toBe(0)
    expect(left?.trimOutMs).toBe(splitAt)

    expect(right?.startMs).toBe(splitAt)
    expect(right?.endMs).toBe(durationMs)
    expect(right?.trimInMs).toBe(splitAt)
    expect(right?.trimOutMs).toBe(durationMs)

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(2)
  })

  test('splitClipAt outside clip range returns null and does nothing', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const r1 = await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: {
            splitClipAt: (id: string, atMs: number) => string | null
          }
        }
        return w.__reelsStore.splitClipAt(cid, 50)
      },
      { cid: clipId }
    )
    expect(r1).toBeNull()

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(1)
  })

  test('Delete shortcut removes the selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Click on the clip body to select it (also blurs any focused input).
    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()
    // Verify selected before pressing the shortcut.
    const sel = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi: {
          getState: () => { selectedClipIds: Set<string> }
        }
      }
      return Array.from(w.__reelsTimelineUi.getState().selectedClipIds)
    })
    expect(sel.length).toBe(1)

    await page.keyboard.press('Delete')

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(0)
  })

  test('duplicateClip places a copy right after the original', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const newId = await page.evaluate((cid) => {
      const w = window as unknown as {
        __reelsStore: { duplicateClip: (id: string) => string | null }
      }
      return w.__reelsStore.duplicateClip(cid)
    }, clipId)
    expect(newId).not.toBeNull()

    const orig = await getClip(clipId)
    const dup = await getClip(newId as string)
    expect(dup?.startMs).toBe(orig?.endMs)
    expect((dup?.endMs ?? 0) - (dup?.startMs ?? 0)).toBe(
      (orig?.endMs ?? 0) - (orig?.startMs ?? 0)
    )
    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(2)
  })

  test('Ctrl+D shortcut duplicates the selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()

    await page.keyboard.press('Control+d')

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(2)
  })

  test('setClipSpeed keeps startMs fixed and shrinks endMs at 2×', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
        w.__reelsStore.setClipSpeed(cid, 2)
      },
      { cid: clipId }
    )

    const after = await getClip(clipId)
    expect(after?.startMs).toBe(0)
    expect(after?.speed).toBe(2)
    // Source duration was `durationMs`; at 2× speed timeline span is durationMs / 2.
    const expected = Math.round(durationMs / 2)
    expect(after?.endMs).toBe(expected)
  })

  test('setClipSpeed at 0.5× expands timeline duration', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
        w.__reelsStore.setClipSpeed(cid, 0.5)
      },
      { cid: clipId }
    )

    const after = await getClip(clipId)
    expect(after?.speed).toBe(0.5)
    // 0.5× = double the timeline length.
    expect(after?.endMs).toBe(Math.round(durationMs / 0.5))
  })

  test('total duration recomputes after speed change', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const before = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: { tracks: Array<{ clips: Array<{ endMs: number }> }> }
          }
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      let m = 0
      for (const t of tracks) for (const c of t.clips) if (c.endMs > m) m = c.endMs
      return m
    })
    expect(before).toBe(durationMs)

    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
        w.__reelsStore.setClipSpeed(cid, 2)
      },
      { cid: clipId }
    )
    const afterTotal = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsStore: {
          state: () => {
            project: { tracks: Array<{ clips: Array<{ endMs: number }> }> }
          }
        }
      }
      const tracks = w.__reelsStore.state().project.tracks
      let m = 0
      for (const t of tracks) for (const c of t.clips) if (c.endMs > m) m = c.endMs
      return m
    })
    expect(afterTotal).toBeLessThan(before)
    expect(afterTotal).toBe(Math.round(durationMs / 2))
  })

  test('setClipSpeed clamps to allowed range [0.1, 10]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
        w.__reelsStore.setClipSpeed(cid, 9999)
      },
      { cid: clipId }
    )
    let after = await getClip(clipId)
    expect(after?.speed).toBe(10)

    await page.evaluate(
      ({ cid }) => {
        const w = window as unknown as {
          __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
        }
        w.__reelsStore.setClipSpeed(cid, 0.0001)
      },
      { cid: clipId }
    )
    after = await getClip(clipId)
    expect(after?.speed).toBe(0.1)
  })

  test('selection model: selectClip stores a single id, clearSelection empties it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const sel = await page.evaluate((cid) => {
      const w = window as unknown as {
        __reelsTimelineUi: {
          getState: () => {
            selectClip: (id: string) => void
            selectedClipIds: Set<string>
          }
        }
      }
      w.__reelsTimelineUi.getState().selectClip(cid)
      return Array.from(w.__reelsTimelineUi.getState().selectedClipIds)
    }, clipId)
    expect(sel).toEqual([clipId])

    const cleared = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi: {
          getState: () => {
            clearSelection: () => void
            selectedClipIds: Set<string>
          }
        }
      }
      w.__reelsTimelineUi.getState().clearSelection()
      return Array.from(w.__reelsTimelineUi.getState().selectedClipIds)
    })
    expect(cleared).toEqual([])
  })

  test('Home and End keys move playhead to bounds', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    await page.locator('[data-testid="timeline"]').click()
    await page.keyboard.press('End')
    let p = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi: { getState: () => { playheadMs: number } }
      }
      return w.__reelsTimelineUi.getState().playheadMs
    })
    expect(p).toBe(durationMs)

    await page.keyboard.press('Home')
    p = await page.evaluate(() => {
      const w = window as unknown as {
        __reelsTimelineUi: { getState: () => { playheadMs: number } }
      }
      return w.__reelsTimelineUi.getState().playheadMs
    })
    expect(p).toBe(0)
  })

  test('Right-click on a clip opens the context menu', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    const clip = page.locator('[data-testid="timeline-clip"]').first()
    await clip.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible()
    await expect(page.locator('[data-testid="ctx-duplicate"]')).toBeVisible()
    await expect(page.locator('[data-testid="ctx-delete"]')).toBeVisible()

    // Escape closes the menu.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveCount(0)
  })

  test('S key splits the selected clip at the playhead', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Set playhead first.
    await page.evaluate(
      (ms) => {
        const w = window as unknown as {
          __reelsTimelineUi: {
            getState: () => { setPlayheadMs: (ms: number) => void }
          }
        }
        w.__reelsTimelineUi.getState().setPlayheadMs(ms)
      },
      Math.floor(durationMs / 2)
    )

    // Click the clip to select it.
    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()

    await page.keyboard.press('s')

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(2)
  })
})
