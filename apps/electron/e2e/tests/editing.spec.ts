import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

/**
 * Phase 2.3 — trim / split / duplicate / speed / shortcuts.
 *
 * We drive the store deterministically through the renderer-side test
 * bridge to avoid HTML5 DnD flakiness inside the Electron sandbox.
 */
test.describe('@phase-2-editing core editing ops', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    // Wait for the renderer bridge to mount.
    await page.waitForFunction(() => !!window.electron?.fs, null, {
      timeout: 5_000
    })
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

  // -------------------------------------------------------------------------
  // Helpers
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

    const result = await page.evaluate(async (filePath: string) => {
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
    return result
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

  async function getClip(clipId: string): Promise<{
    kind: string
    startMs: number
    endMs: number
    trimInMs?: number
    trimOutMs?: number
    speed?: number
  } | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  clips: Array<{
                    id: string
                    kind: string
                    startMs: number
                    endMs: number
                    trimInMs?: number
                    trimOutMs?: number
                    speed?: number
                  }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const tracks = reels.state().project.tracks
      for (const t of tracks)
        for (const c of t.clips)
          if (c.id === cid)
            return {
              kind: c.kind,
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
  // Trim handles
  // -------------------------------------------------------------------------
  test('trim-handle-left action narrows clip from left, updates trimInMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Apply what a trim-left drag of 1000ms (speed 1×) would do.
    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              updateMediaClipTrim: (id: string, partial: unknown) => void
            }
          }
        ).__reelsStore
        reels.updateMediaClipTrim(cid, { startMs: 1000, trimInMs: 1000 })
      },
      { cid: clipId }
    )

    const after = await getClip(clipId)
    expect(after?.startMs).toBe(1000)
    expect(after?.trimInMs).toBe(1000)
    expect(after?.endMs).toBe(durationMs)
    expect((after?.endMs ?? 0) - (after?.startMs ?? 0)).toBe(durationMs - 1000)
  })

  test('trim-handle-right action narrows clip from right, updates trimOutMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const newEnd = durationMs - 1000
    await page.evaluate(
      ({ cid, end }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              updateMediaClipTrim: (id: string, partial: unknown) => void
            }
          }
        ).__reelsStore
        reels.updateMediaClipTrim(cid, { endMs: end, trimOutMs: end })
      },
      { cid: clipId, end: newEnd }
    )
    const after = await getClip(clipId)
    expect(after?.endMs).toBe(newEnd)
    expect(after?.trimOutMs).toBe(newEnd)
    expect(after?.startMs).toBe(0)
  })

  test('media clip exposes trim handles with col-resize cursor; caption clip does NOT', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)
    // Add a caption to compare against.
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    await page.locator('[data-testid="caption-editor-close"]').click()

    await expect(page.locator('[data-testid="trim-handle-left"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="trim-handle-right"]')).toHaveCount(1)
    const cursor = await page
      .locator('[data-testid="trim-handle-left"]')
      .evaluate((el) => getComputedStyle(el).cursor)
    expect(cursor).toBe('col-resize')
  })

  // -------------------------------------------------------------------------
  // Split
  // -------------------------------------------------------------------------
  test('splitClipAt produces two media clips with chained trim points', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const splitAt = Math.floor(durationMs / 2)
    const rightId = await page.evaluate(
      ({ cid, ms }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              splitClipAt: (id: string, atMs: number) => string | null
            }
          }
        ).__reelsStore
        return reels.splitClipAt(cid, ms)
      },
      { cid: clipId, ms: splitAt }
    )
    expect(rightId).not.toBeNull()

    const left = await getClip(clipId)
    const right = await getClip(rightId as string)
    expect(left?.startMs).toBe(0)
    expect(left?.endMs).toBe(splitAt)
    expect(left?.trimInMs).toBe(0)
    expect(left?.trimOutMs).toBe(splitAt)
    expect(right?.startMs).toBe(splitAt)
    expect(right?.endMs).toBe(durationMs)
    expect(right?.trimInMs).toBe(splitAt)
    expect(right?.trimOutMs).toBe(durationMs)
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(2)
  })

  test('splitClipAt outside clip returns null and does not split', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const r = await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              splitClipAt: (id: string, atMs: number) => string | null
            }
          }
        ).__reelsStore
        return reels.splitClipAt(cid, 50)
      },
      { cid: clipId }
    )
    expect(r).toBeNull()
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(1)
  })

  test('splitClipAt is a no-op on caption clips (returns null)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // Add a caption via the button.
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    const captionId = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string; kind: string }>
                }>
              }
            }
          }
        }
      ).__reelsStore
      const t = reels.state().project.tracks.find((t) => t.kind === 'caption')
      return t?.clips[0]?.id ?? null
    })
    expect(captionId).not.toBeNull()
    const r = await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            splitClipAt: (id: string, atMs: number) => string | null
          }
        }
      ).__reelsStore
      return reels.splitClipAt(id as string, 1500)
    }, captionId)
    expect(r).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Duplicate
  // -------------------------------------------------------------------------
  test('duplicateClip places a media copy at the next free slot', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const newId = await page.evaluate((cid) => {
      const reels = (
        window as unknown as {
          __reelsStore: { duplicateClip: (id: string) => string | null }
        }
      ).__reelsStore
      return reels.duplicateClip(cid)
    }, clipId)
    expect(newId).not.toBeNull()

    const orig = await getClip(clipId)
    const dup = await getClip(newId as string)
    expect(dup?.startMs).toBe(orig?.endMs)
    expect((dup?.endMs ?? 0) - (dup?.startMs ?? 0)).toBe(
      (orig?.endMs ?? 0) - (orig?.startMs ?? 0)
    )
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(2)
  })

  test('duplicateClip also works on caption clips and deep-copies spans', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    const captionId = await page.evaluate(() => {
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
      return reels.state().project.tracks.find((t) => t.kind === 'caption')!
        .clips[0].id
    })
    const dupId = await page.evaluate((id) => {
      const reels = (
        window as unknown as {
          __reelsStore: { duplicateClip: (id: string) => string | null }
        }
      ).__reelsStore
      return reels.duplicateClip(id as string)
    }, captionId)
    expect(dupId).not.toBeNull()
    await expect(page.locator('[data-testid="caption-clip-block"]')).toHaveCount(2)

    // Verify the duplicate has its own spans (mutation isolation).
    const sameRef = await page.evaluate(
      ({ a, b }) => {
        const reels = (
          window as unknown as {
            __reelsStore: {
              state: () => {
                project: {
                  tracks: Array<{
                    kind: string
                    clips: Array<{
                      id: string
                      kind: string
                      spans?: unknown[]
                    }>
                  }>
                }
              }
            }
          }
        ).__reelsStore
        const tracks = reels.state().project.tracks
        let A: { spans?: unknown[] } | null = null
        let B: { spans?: unknown[] } | null = null
        for (const t of tracks)
          for (const c of t.clips) {
            if (c.id === a) A = c
            if (c.id === b) B = c
          }
        return A && B ? A.spans === B.spans : null
      },
      { a: captionId, b: dupId }
    )
    expect(sameRef).toBe(false)
  })

  test('Ctrl+D shortcut duplicates the selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    // Click clip body to select.
    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()
    await page.keyboard.press('Control+d')
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(2)
  })

  // -------------------------------------------------------------------------
  // Delete shortcut
  // -------------------------------------------------------------------------
  test('Delete shortcut removes the selected clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page
      .locator(`[data-testid="clip-body"][data-clip-id="${clipId}"]`)
      .click()
    // Verify selection mirrored.
    const sel = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => { selectedClipIds: Set<string> }
          }
        }
      ).__reelsTimelineUi
      return Array.from(ui.getState().selectedClipIds)
    })
    expect(sel.length).toBe(1)

    await page.keyboard.press('Delete')
    await expect(page.locator('[data-testid="media-clip-block"]')).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // Speed
  // -------------------------------------------------------------------------
  test('setClipSpeed at 2× keeps startMs fixed and halves endMs', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
          }
        ).__reelsStore
        reels.setClipSpeed(cid, 2)
      },
      { cid: clipId }
    )
    const after = await getClip(clipId)
    expect(after?.startMs).toBe(0)
    expect(after?.speed).toBe(2)
    expect(after?.endMs).toBe(Math.round(durationMs / 2))
  })

  test('setClipSpeed at 0.5× doubles the timeline duration', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
          }
        ).__reelsStore
        reels.setClipSpeed(cid, 0.5)
      },
      { cid: clipId }
    )
    const after = await getClip(clipId)
    expect(after?.speed).toBe(0.5)
    expect(after?.endMs).toBe(Math.round(durationMs / 0.5))
  })

  test('setClipSpeed clamps to [0.1, 10]', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
          }
        ).__reelsStore
        reels.setClipSpeed(cid, 9999)
      },
      { cid: clipId }
    )
    let after = await getClip(clipId)
    expect(after?.speed).toBe(10)

    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
          }
        ).__reelsStore
        reels.setClipSpeed(cid, 0.0001)
      },
      { cid: clipId }
    )
    after = await getClip(clipId)
    expect(after?.speed).toBe(0.1)
  })

  test('setClipSpeed is a no-op on caption clips (kind=caption preserved)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click()
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()

    const cap = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: {
                tracks: Array<{
                  kind: string
                  clips: Array<{ id: string; endMs: number }>
                }>
              }
            }
            setClipSpeed: (id: string, speed: number) => void
          }
        }
      ).__reelsStore
      const t = reels.state().project.tracks.find((t) => t.kind === 'caption')!
      const c = t.clips[0]
      const beforeEnd = c.endMs
      reels.setClipSpeed(c.id, 4)
      const after = reels
        .state()
        .project.tracks.find((t) => t.kind === 'caption')!
        .clips.find((cc) => cc.id === c.id) as {
        kind: string
        endMs: number
        speed?: number
      }
      return { beforeEnd, afterKind: after.kind, afterEnd: after.endMs, speed: after.speed }
    })
    expect(cap.afterKind).toBe('caption')
    expect(cap.afterEnd).toBe(cap.beforeEnd)
    expect(cap.speed).toBeUndefined()
  })

  test('total duration recomputes after speed change', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const before = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ clips: Array<{ endMs: number }> }> }
            }
          }
        }
      ).__reelsStore
      let m = 0
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.endMs > m) m = c.endMs
      return m
    })
    expect(before).toBe(durationMs)

    await page.evaluate(
      ({ cid }) => {
        const reels = (
          window as unknown as {
            __reelsStore: { setClipSpeed: (id: string, speed: number) => void }
          }
        ).__reelsStore
        reels.setClipSpeed(cid, 2)
      },
      { cid: clipId }
    )
    const after = await page.evaluate(() => {
      const reels = (
        window as unknown as {
          __reelsStore: {
            state: () => {
              project: { tracks: Array<{ clips: Array<{ endMs: number }> }> }
            }
          }
        }
      ).__reelsStore
      let m = 0
      for (const t of reels.state().project.tracks)
        for (const c of t.clips) if (c.endMs > m) m = c.endMs
      return m
    })
    expect(after).toBeLessThan(before)
    expect(after).toBe(Math.round(durationMs / 2))
  })

  // -------------------------------------------------------------------------
  // Context menu kinds
  // -------------------------------------------------------------------------
  test('media clip context menu HAS 속도 entry; caption clip does NOT', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    await addVideoClip(durationMs, mediaId)

    // Media clip right-click.
    await page.locator('[data-testid="media-clip-block"]').first().click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible()
    await expect(page.locator('[data-testid="menu-speed"]')).toBeVisible()
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveAttribute(
      'data-clip-kind',
      'media'
    )
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveCount(0)

    // Caption clip right-click.
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    await page.locator('[data-testid="caption-editor-close"]').click()

    await page
      .locator('[data-testid="caption-clip-block"]')
      .first()
      .click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible()
    await expect(page.locator('[data-testid="menu-speed"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="menu-edit-caption"]')).toBeVisible()
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveAttribute(
      'data-clip-kind',
      'caption'
    )
  })

  // -------------------------------------------------------------------------
  // Selection model
  // -------------------------------------------------------------------------
  test('selection model: selectClip stores single id; clearSelection empties it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const { mediaId, durationMs } = await openEditorWithMedia()
    const clipId = await addVideoClip(durationMs, mediaId)

    const sel = await page.evaluate((cid) => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => {
              selectClip: (id: string) => void
              selectedClipIds: Set<string>
            }
          }
        }
      ).__reelsTimelineUi
      ui.getState().selectClip(cid as string)
      return Array.from(ui.getState().selectedClipIds)
    }, clipId)
    expect(sel).toEqual([clipId])

    const cleared = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          __reelsTimelineUi: {
            getState: () => {
              clearSelection: () => void
              selectedClipIds: Set<string>
            }
          }
        }
      ).__reelsTimelineUi
      ui.getState().clearSelection()
      return Array.from(ui.getState().selectedClipIds)
    })
    expect(cleared).toEqual([])
  })
})
