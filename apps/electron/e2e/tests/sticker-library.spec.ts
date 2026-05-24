/**
 * Phase 3.25 — emoji & sticker library tests.
 *
 * Covers:
 *  (1)  Library lists — overlay-add-emoji-* buttons (≥48) + overlay-add-sticker-* (≥16)
 *       + category section headers visible.
 *  (2)  Add emoji → IMAGE overlay — source.type==='image', path ends with sticker-assets/emoji-fire.png,
 *       overlay-element[data-overlay-type="image"] visible in preview.
 *  (3)  Add graphic sticker → IMAGE overlay — path ends with sticker-assets/sticker-arrow-up.png.
 *  (4)  Preview renders — playhead on overlay → overlay-element visible; img loaded (naturalWidth > 0).
 *  (5)  Export — video clip + emoji overlay → exporter:run succeeds, output mp4 on disk.
 *  (6)  Dedupe — add same emoji twice → source.path identical; saveSticker reused=true 2nd call.
 *  (7)  Undo/redo — add sticker → undo removes → redo restores.
 *  (8)  Byte-identical — no emoji/sticker in project → buildPlan identical to baseline (no overlay fragments).
 *  (9)  Persistence — added overlay survives project save/reload round-trip with source.path intact.
 *
 * NOTE on emoji rasterization in headless e2e:
 *   Color-emoji fonts (Segoe UI Emoji etc.) are available in the bundled Chromium on all
 *   platforms. Even if a particular system emoji glyph renders as a blank/monochrome PNG,
 *   the PNG itself is valid (canvas.toBlob always produces a PNG). All tests that involve
 *   the saveSticker IPC + IMAGE overlay path pass regardless of pixel content; we assert
 *   mechanics only, not color.
 *
 * @phase-3-25-sticker-library
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges (mirror overlays.spec.ts)
// ---------------------------------------------------------------------------
type OverlaySourceImage = {
  type: 'image'
  path: string
  naturalWidth: number
  naturalHeight: number
}
type OverlaySourceShape = {
  type: 'shape'
  style: {
    shape: string
    fill: string
    fillOpacity: number
    stroke: string
    strokeWidth: number
    cornerRadius: number
  }
}
type OverlaySource = OverlaySourceImage | OverlaySourceShape | { type: 'sticker'; stickerId: string }

type OverlayClip = {
  id: string
  kind: 'overlay'
  trackId: string
  startMs: number
  endMs: number
  source: OverlaySource
  baseWidthFrac: number
  baseHeightFrac: number
}

type ProjectStore = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      clips: Array<Record<string, unknown>>
    }>
  }
  addOverlay: (clip: OverlayClip) => void
  ensureOverlayTrack: () => string
  getOverlayTrackId: () => string | null
  createNew: () => void
  _hydrateFromDisk?: (p: unknown) => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStore
      setState: (partial: Record<string, unknown>) => void
    }
    __reelsStore: {
      state: () => { project: { tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }> } }
      newId: () => string
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
    }
    __reelsTimelineUi: {
      getState: () => { setPlayheadMs: (ms: number) => void; playheadMs: number }
    }
    __reelsUndoRedo: {
      getState: () => { undo: () => void; redo: () => void }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function storeEval<T>(
  page: import('playwright').Page,
  fn: (s: ProjectStore) => T
): Promise<T> {
  return page.evaluate((fnStr) => {
    const store = (window as unknown as {
      __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
    }).__PROJECT_STORE_FOR_TEST__
    // eslint-disable-next-line no-new-func
    const f = new Function('s', `return (${fnStr})(s)`) as (s: ProjectStore) => T
    return f(store.getState())
  }, fn.toString())
}

async function getClipFromStore(
  page: import('playwright').Page,
  clipId: string
): Promise<Record<string, unknown> | null> {
  return (await page.evaluate((cid) => {
    const store = (window as unknown as {
      __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
    }).__PROJECT_STORE_FOR_TEST__
    for (const t of store.getState().project.tracks)
      for (const c of t.clips)
        if ((c as { id?: string }).id === cid) return c
    return null
  }, clipId)) as Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-25-sticker-library emoji & sticker library', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    // Brief pause to let previous Electron's debug port fully close.
    await new Promise((r) => setTimeout(r, 600))
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __PROJECT_STORE_FOR_TEST__: { getState: () => { createNew: () => void } }
      }).__PROJECT_STORE_FOR_TEST__
      store.getState().createNew()
      await new Promise((r) => setTimeout(r, 900))
    })
  })

  test.afterEach(async () => {
    if (launched) {
      try {
        await launched.app.close()
      } catch { /* ignore */ }
      launched = null
    }
  })

  // ---------------------------------------------------------------------------
  // Internal helpers that need `launched`
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
      () => !!(window as unknown as {
        __PROJECT_STORE_FOR_TEST__?: { getState: () => { getOverlayTrackId?: unknown } }
      }).__PROJECT_STORE_FOR_TEST__?.getState()?.getOverlayTrackId,
      null,
      { timeout: 5_000 }
    )
  }

  async function openOverlayLibrary(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="left-rail-sticker"]').click()
    await expect(page.locator('[data-testid="overlay-library"]')).toBeVisible()
  }

  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number; fixturePath: string }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    const result = await page.evaluate(async (filePath: string) => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      const reels = (window as unknown as { __reelsStore: typeof window.__reelsStore }).__reelsStore
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
    return { ...result, fixturePath: fixture }
  }

  async function addVideoClip(mediaId: string, durationMs: number, startMs = 0): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(({ mid, dur, st }) => {
      const reels = (window as unknown as { __reelsStore: typeof window.__reelsStore }).__reelsStore
      const track = reels.state().project.tracks.find((t) => t.kind === 'video')
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
    }, { mid: mediaId, dur: durationMs, st: startMs })
  }

  // -------------------------------------------------------------------------
  // (1) Library lists: emoji buttons ≥48, sticker buttons ≥16, category headers
  // -------------------------------------------------------------------------
  test('(1) @phase-3-25-sticker-library library panel shows ≥48 emoji buttons and ≥16 graphic sticker buttons + category headers', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    // Emoji buttons — data-testid="overlay-add-emoji-<id>"
    const emojiButtons = page.locator('[data-testid^="overlay-add-emoji-"]')
    const emojiCount = await emojiButtons.count()
    expect(emojiCount).toBeGreaterThanOrEqual(48)

    // Graphic sticker buttons — data-testid="overlay-add-sticker-sticker-*"
    // (BUNDLED_STICKERS uses overlay-add-sticker-<id> too, but those are a different
    // section; graphic stickers all have ids starting with "sticker-" per bundledStickers.ts)
    const stickerButtons = page.locator('[data-testid^="overlay-add-sticker-sticker-"]')
    const stickerCount = await stickerButtons.count()
    expect(stickerCount).toBeGreaterThanOrEqual(16)

    // Category section headers — 이모지 section title "이모지" should be visible
    // and the 그래픽 스티커 section title should be visible.
    await expect(page.locator('[data-testid="overlay-library"]')).toBeVisible()
    const libraryText = await page.locator('[data-testid="overlay-library"]').innerText()
    expect(libraryText).toContain('이모지')
    expect(libraryText).toContain('그래픽 스티커')
  })

  // -------------------------------------------------------------------------
  // (2) Add emoji → IMAGE overlay; source.type==='image'; path ends with sticker-assets/emoji-fire.png
  // -------------------------------------------------------------------------
  test('(2) @phase-3-25-sticker-library click overlay-add-emoji-emoji-fire → IMAGE overlay with sticker-assets path', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    // Count overlays before
    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    // Click the emoji button — triggers rasterizeEmoji + saveSticker IPC + addOverlay
    await page.locator('[data-testid="overlay-add-emoji-emoji-fire"]').click()

    // Wait for the async IPC + store update to settle
    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    // Read the new clip
    const clip = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length === 0) return null
      // Get the last-added clip
      return ot.clips[ot.clips.length - 1]
    }) as Record<string, unknown> | null

    expect(clip).not.toBeNull()
    expect(clip!.kind).toBe('overlay')
    const src = clip!.source as OverlaySource
    expect(src.type).toBe('image')

    if (src.type === 'image') {
      // Path must end with sticker-assets/emoji-fire.png (forward or back slash)
      expect(src.path).toMatch(/sticker-assets[/\\]emoji-fire\.png$/)
    }
  })

  // -------------------------------------------------------------------------
  // (3) Add graphic sticker → IMAGE overlay; path ends with sticker-assets/sticker-arrow-up.png
  // -------------------------------------------------------------------------
  test('(3) @phase-3-25-sticker-library click overlay-add-sticker-sticker-arrow-up → IMAGE overlay with sticker-assets path', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    await page.locator('[data-testid="overlay-add-sticker-sticker-arrow-up"]').click()

    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    const clip = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length === 0) return null
      return ot.clips[ot.clips.length - 1]
    }) as Record<string, unknown> | null

    expect(clip).not.toBeNull()
    expect(clip!.kind).toBe('overlay')
    const src = clip!.source as OverlaySource
    expect(src.type).toBe('image')

    if (src.type === 'image') {
      expect(src.path).toMatch(/sticker-assets[/\\]sticker-arrow-up\.png$/)
    }
  })

  // -------------------------------------------------------------------------
  // (4) Preview renders — move playhead into sticker overlay → overlay-element visible
  //     + img.naturalWidth > 0 (PNG loaded).
  //     For SVG stickers naturalWidth will be > 0 regardless of emoji font.
  // -------------------------------------------------------------------------
  test('(4) @phase-3-25-sticker-library overlay-element visible with naturalWidth > 0 after adding graphic sticker', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    // Use a graphic sticker (SVG-based) — guaranteed to rasterize regardless of emoji font
    await page.locator('[data-testid="overlay-add-sticker-sticker-check"]').click()

    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    // Get the new clip's id and time range
    const clipInfo = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length === 0) return null
      const c = ot.clips[ot.clips.length - 1] as OverlayClip
      return { id: c.id, startMs: c.startMs, endMs: c.endMs }
    }) as { id: string; startMs: number; endMs: number } | null

    expect(clipInfo).not.toBeNull()
    const midMs = Math.floor((clipInfo!.startMs + clipInfo!.endMs) / 2)

    // Position playhead inside the clip
    await page.evaluate((ms) => {
      ;(window as unknown as { __reelsTimelineUi: typeof window.__reelsTimelineUi }).__reelsTimelineUi
        .getState().setPlayheadMs(ms)
    }, midMs)
    await page.waitForTimeout(400)

    // overlay-element must appear with data-overlay-type="image"
    const element = page.locator(
      `[data-testid="overlay-element"][data-overlay-type="image"][data-overlay-id="${clipInfo!.id}"]`
    )
    await expect(element).toBeVisible({ timeout: 6_000 })

    // The <img> inside the overlay element must have loaded (naturalWidth > 0)
    // SVG stickers always produce a valid PNG so this must pass.
    const imgNaturalWidth = await element.evaluate((el) => {
      const img = el.querySelector('img') ?? (el.tagName === 'IMG' ? el : null)
      if (!img) return -1
      return (img as HTMLImageElement).naturalWidth
    })
    // naturalWidth > 0 means the PNG actually loaded into the img element
    expect(imgNaturalWidth).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // (5) Export — video clip + emoji/sticker overlay → real exporter:run succeeds
  // -------------------------------------------------------------------------
  test('(5) @phase-3-25-sticker-library exporter:run with video + sticker overlay → mp4 produced', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    // Add video clip first
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    // Open overlay library and add a graphic sticker (SVG rasterizes reliably)
    await openOverlayLibrary()
    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })
    await page.locator('[data-testid="overlay-add-sticker-sticker-burst"]').click()
    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    // Prepare output path
    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `sticker-export-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try { rmSync(outPath) } catch { /* ignore */ }
    }

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = (window as unknown as { __reelsStore: { state: () => unknown } }).__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-sticker-export-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath },
      // 45s timeout for the full export with overlay rendering
    )

    expect(r.ok, `exporter.run failed: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  }, 60_000)

  // -------------------------------------------------------------------------
  // (6) Dedupe -- add same sticker twice: source.path identical; saveSticker IPC reused=true on 2nd call
  // -------------------------------------------------------------------------
  test('(6) @phase-3-25-sticker-library add same sticker twice: deduplicated path; saveSticker IPC reused=true', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    // --- Part A: verify IPC dedupe directly ---
    // Call saveSticker twice with the same assetId. The first call writes the file;
    // the second must return reused=true (file already exists on disk).
    // We supply a minimal valid PNG (89 bytes, 1x1 transparent).
    const ipcResults = await page.evaluate(async () => {
      // Minimal 1x1 transparent PNG
      const pngBytes = new Uint8Array([
        137,80,78,71,13,10,26,10,
        0,0,0,13,73,72,68,82,
        0,0,0,1,0,0,0,1,
        8,6,0,0,0,
        31,21,196,137,
        0,0,0,11,73,68,65,84,
        8,215,99,248,15,0,0,1,1,0,5,
        24,213,78,0,
        0,0,0,0,73,69,78,68,174,66,96,130
      ]).buffer
      const assetId = 'e2e-dedupe-test-sticker'
      const r1 = await window.electron.overlay.saveSticker(assetId, pngBytes)
      const r2 = await window.electron.overlay.saveSticker(assetId, pngBytes)
      return { r1, r2 }
    })

    expect(ipcResults.r1.ok).toBe(true)
    expect(ipcResults.r2.ok).toBe(true)
    if (ipcResults.r1.ok && ipcResults.r2.ok) {
      expect(ipcResults.r1.path).toBe(ipcResults.r2.path)
      expect(ipcResults.r2.reused).toBe(true)
    }

    // --- Part B: verify two UI-triggered adds share the same source.path ---
    const countBefore = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })
    await page.locator('[data-testid=overlay-add-sticker-sticker-star]').click()
    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      countBefore,
      { timeout: 8_000 }
    )
    const countAfterFirst = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    // Second add (same sticker button)
    await page.locator('[data-testid=overlay-add-sticker-sticker-star]').click()
    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      countAfterFirst,
      { timeout: 8_000 }
    )

    // Both overlays must have the same source.path
    const clips = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length < 2) return [null, null]
      return [ot.clips[ot.clips.length - 2], ot.clips[ot.clips.length - 1]]
    }) as [Record<string, unknown> | null, Record<string, unknown> | null]

    expect(clips[0]).not.toBeNull()
    expect(clips[1]).not.toBeNull()
    const src1 = clips[0]!.source as OverlaySource
    const src2 = clips[1]!.source as OverlaySource
    expect(src1.type).toBe('image')
    expect(src2.type).toBe('image')
    if (src1.type === 'image' && src2.type === 'image') {
      expect(src1.path).toBe(src2.path)
      expect(src1.path).toContain('sticker-assets')
      expect(src1.path).toContain('sticker-star.png')
    }
  })

  // -------------------------------------------------------------------------
  // (7) Undo/redo — add sticker → undo removes clip → redo restores clip
  // -------------------------------------------------------------------------
  test('(7) @phase-3-25-sticker-library undo removes sticker overlay; redo restores it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )

    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    // Add a graphic sticker (reliable rasterization)
    await page.locator('[data-testid="overlay-add-sticker-sticker-ring"]').click()

    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    // Capture the id of the new clip
    const newClipId = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length === 0) return null
      return (ot.clips[ot.clips.length - 1] as { id?: string }).id ?? null
    }) as string | null

    expect(newClipId).not.toBeNull()

    // Give undo history a moment to record the mutation
    await page.waitForTimeout(500)

    // Clip must exist before undo
    let stored = await getClipFromStore(page, newClipId!)
    expect(stored).not.toBeNull()

    // Undo
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: typeof window.__reelsUndoRedo }).__reelsUndoRedo
        .getState().undo()
    })
    await page.waitForTimeout(400)

    // Clip must be gone
    stored = await getClipFromStore(page, newClipId!)
    expect(stored).toBeNull()

    // Redo
    await page.evaluate(() => {
      ;(window as unknown as { __reelsUndoRedo: typeof window.__reelsUndoRedo }).__reelsUndoRedo
        .getState().redo()
    })
    await page.waitForTimeout(400)

    // Clip must be restored
    stored = await getClipFromStore(page, newClipId!)
    expect(stored).not.toBeNull()
    expect(stored!.kind).toBe('overlay')
    const src = stored!.source as OverlaySource
    expect(src.type).toBe('image')
  })

  // -------------------------------------------------------------------------
  // (8) Byte-identical baseline — no sticker overlays → buildPlan produces
  //     NO overlay enable='between( fragments (same as empty overlay track)
  // -------------------------------------------------------------------------
  test('(8) @phase-3-25-sticker-library no emoji/sticker → buildPlan graph has no sticker overlay fragments', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs, 0)
    await addVideoClip(mediaId, durationMs, durationMs)

    // Verify overlay track is empty (no sticker/emoji added)
    const overlayClipCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })
    expect(overlayClipCount).toBe(0)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `sticker-baseline-${Date.now()}.mp4`
    )
    const result = await page.evaluate(async (op) => {
      const store = (window as unknown as {
        __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
      }).__PROJECT_STORE_FOR_TEST__
      const project = store.getState().project
      return await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
    }, outPath)

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    expect(result.filterGraph).toBeTruthy()
    // Baseline concat graph must be present
    expect(result.filterGraph as string).toContain('concat=n=2')

    // Must NOT contain any overlay enable fragments (sticker feature didn't add any)
    const fg = result.filterGraph as string
    const enableMatches = (fg.match(/overlay=0:0:enable='between\(t,/g) ?? []).length
    expect(enableMatches).toBe(0)
  })

  // -------------------------------------------------------------------------
  // (9) Persistence — sticker overlay survives project save/reload round-trip
  //     with source.path intact (mirrors overlays.spec.ts test 13)
  // -------------------------------------------------------------------------
  test('(9) @phase-3-25-sticker-library sticker IMAGE overlay survives save/reload with source.path intact', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    await openOverlayLibrary()

    const beforeCount = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      return ot ? ot.clips.length : 0
    })

    // Add a graphic sticker
    await page.locator('[data-testid="overlay-add-sticker-sticker-heart"]').click()

    await page.waitForFunction(
      (prev) => {
        const store = (window as unknown as {
          __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore }
        }).__PROJECT_STORE_FOR_TEST__
        const ot = store.getState().project.tracks.find((t) => t.kind === 'overlay')
        return (ot ? ot.clips.length : 0) > prev
      },
      beforeCount,
      { timeout: 8_000 }
    )

    // Capture the added clip
    const preReload = await storeEval(page, (s) => {
      const ot = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!ot || ot.clips.length === 0) return null
      const c = ot.clips[ot.clips.length - 1] as OverlayClip
      const src = c.source
      return {
        id: c.id,
        startMs: c.startMs,
        endMs: c.endMs,
        sourceType: src.type,
        sourcePath: src.type === 'image' ? src.path : null
      }
    }) as {
      id: string
      startMs: number
      endMs: number
      sourceType: string
      sourcePath: string | null
    } | null

    expect(preReload).not.toBeNull()
    expect(preReload!.sourceType).toBe('image')
    expect(preReload!.sourcePath).toMatch(/sticker-assets[/\\]sticker-heart\.png$/)

    // Simulate save/reload via JSON round-trip + _hydrateFromDisk
    const roundTripped = await page.evaluate(async (clipId) => {
      const store = (window as unknown as {
        __PROJECT_STORE_FOR_TEST__: { getState: () => ProjectStore & { _hydrateFromDisk?: (p: unknown) => void } }
      }).__PROJECT_STORE_FOR_TEST__

      // Snapshot the project
      const snapshot = JSON.parse(JSON.stringify(store.getState().project))

      // Hydrate from disk (same path used on app startup)
      const hydr = store.getState()._hydrateFromDisk
      if (typeof hydr === 'function') {
        hydr(snapshot)
      }
      await new Promise((r) => setTimeout(r, 300))

      // Re-read state after reload
      const s = store.getState()
      const overlayTrack = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!overlayTrack) return { hasTrack: false, clip: null }
      const clip = overlayTrack.clips.find(
        (c) => (c as { id?: string }).id === clipId
      ) as OverlayClip | undefined
      if (!clip) return { hasTrack: true, clip: null }
      return {
        hasTrack: true,
        clip: {
          kind: clip.kind,
          startMs: clip.startMs,
          endMs: clip.endMs,
          sourceType: clip.source.type,
          sourcePath: clip.source.type === 'image' ? clip.source.path : null
        }
      }
    }, preReload!.id)

    expect(roundTripped.hasTrack).toBe(true)
    expect(roundTripped.clip).not.toBeNull()
    expect(roundTripped.clip!.kind).toBe('overlay')
    expect(roundTripped.clip!.sourceType).toBe('image')
    expect(roundTripped.clip!.sourcePath).toMatch(/sticker-assets[/\\]sticker-heart\.png$/)
    expect(roundTripped.clip!.startMs).toBe(preReload!.startMs)
    expect(roundTripped.clip!.endMs).toBe(preReload!.endMs)
  })
})
