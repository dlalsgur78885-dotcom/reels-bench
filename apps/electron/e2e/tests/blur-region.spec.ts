/**
 * Phase 3.11 — "모자이크 / 부분 블러" (mosaic / partial blur regions).
 *
 * Hides faces, logos or sensitive areas by mosaicking or blurring a
 * sub-rectangle or sub-ellipse of the FINAL CANVAS.
 *
 * CONTRACT tested:
 *   VideoAudioClip.blurRegions?: BlurRegion[]
 *   BlurRegion { id; shape:'rectangle'|'ellipse'; x;y;w;h;
 *               effect:'mosaic'|'blur'; strength:0..100 }
 *   getClipBlurRegions(clip) → [] when none
 *   MAX_BLUR_REGIONS_PER_CLIP = 8
 *   Store: addBlurRegion, updateBlurRegion, removeBlurRegion on
 *          __PROJECT_STORE_FOR_TEST__.getState()
 *
 * Scenarios:
 *  (1)  addBlurRegion → blur-region-layer (data-region-count="1") + timeline badge.
 *  (2)  geometry: updateBlurRegion x/y/w/h → blur-region div CSS % updates.
 *  (3)  effect toggle: update effect:'blur' / 'mosaic' → data-region-effect flips;
 *       both produce a non-empty backdropFilter.
 *  (4)  shape toggle: update shape:'ellipse' → data-region-shape="ellipse" +
 *       border-radius:50%.
 *  (5)  strength: updateBlurRegion strength → backdropFilter blur radius changes.
 *  (6)  multi-region: add 3 → 3 blur-region divs; selector chips;
 *       menu-blur-add disabled at MAX_BLUR_REGIONS_PER_CLIP (8).
 *  (7)  remove: removeBlurRegion drops the selected region; removing the last →
 *       blur-region-layer + indicator gone, DOM byte-identical to no-region baseline.
 *  (8)  export with mosaic rectangle → filterGraph has split + crop= + scale=...flags=neighbor
 *       + overlay=...:format=auto.
 *  (8b) export with ellipse blur region → filterGraph also has boxblur= + geq=.
 *  (9)  REGRESSION: clip with no blurRegions → filterGraph has NO br_* labels.
 * (10)  undo/redo: addBlurRegion → undo removes it → redo restores.
 * (11)  region + transform: clip with both blurRegion AND non-identity transform →
 *       buildPlan ok, graph has blur sub-chain AND rotate= / colorchannelmixer=.
 *
 * @phase-3-11-blur
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants mirrored from shared/project.ts (Phase 3.11)
// ---------------------------------------------------------------------------
const MAX_BLUR_REGIONS_PER_CLIP = 8
const DEFAULT_BLUR_REGION_RECT = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }

// ---------------------------------------------------------------------------
// Type bridges
// ---------------------------------------------------------------------------
type BlurRegion = {
  id: string
  shape: 'rectangle' | 'ellipse'
  x: number
  y: number
  w: number
  h: number
  effect: 'mosaic' | 'blur'
  strength: number
}

type ProjectStore = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      clips: Array<Record<string, unknown>>
    }>
  }
  createNew: () => void
  addMedia: (a: unknown) => void
  addClip: (c: unknown) => void
  addBlurRegion: (clipId: string) => void
  updateBlurRegion: (clipId: string, regionId: string, partial: Partial<BlurRegion>) => void
  removeBlurRegion: (clipId: string, regionId: string) => void
  setClipTransform: (id: string, partial: Record<string, number>) => void
  resetClipTransform: (id: string) => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStore
      temporal: {
        getState: () => {
          undo: () => void
          redo: () => void
          pastStates: unknown[]
          futureStates: unknown[]
        }
      }
    }
    __reelsStore: {
      state: () => {
        project: {
          tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }>
        }
      }
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => { setPlayheadMs: (ms: number) => void }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-11-blur mosaic / partial blur regions', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    launched = await launchElectron()
    const { page } = launched
    await page.waitForFunction(() => !!window.electron?.fs, null, { timeout: 5_000 })
    await page.evaluate(async () => {
      window.__PROJECT_STORE_FOR_TEST__.getState().createNew()
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
  // Internal helpers
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
      const reels = window.__reelsStore
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

  async function addVideoClip(mediaId: string, durationMs: number, startMs = 0): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return await page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
        const track = reels.state().project.tracks.find((t) => t.kind === 'video')
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
      { mid: mediaId, dur: durationMs, st: startMs }
    )
  }

  async function getClipFromState(clipId: string): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks) {
        for (const c of t.clips) {
          if ((c as Record<string, unknown>).id === cid) return c
        }
      }
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  /** Right-click the timeline clip block for a given clip id to open the context menu. */
  async function openContextMenu(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const clipBlock = page.locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`)
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })
    // Wait for the context menu to appear.
    await expect(page.locator('[data-testid="menu-blur"]')).toBeVisible({ timeout: 5_000 })
  }

  /** Open the blur panel inside the context menu. */
  async function openBlurPanel(clipId: string): Promise<void> {
    await openContextMenu(clipId)
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    // The context menu may overflow the viewport bottom. Use a JS dispatchEvent
    // to click the element regardless of viewport clipping — equivalent to a
    // programmatic click that fires React's onClick handler.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="menu-blur"]') as HTMLElement | null
      if (el) el.click()
    })
    await expect(page.locator('[data-testid="menu-blur-panel"]')).toBeAttached({ timeout: 3_000 })
  }

  // =========================================================================
  // (1) addBlurRegion → blur-region-layer (data-region-count="1") appears;
  //     blur-region-indicator badge appears on timeline clip.
  // =========================================================================
  test('(1) addBlurRegion → blur-region-layer data-region-count="1" + timeline badge', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Initially: no blur-region-layer, no badge.
    const blurLayer = page.locator('[data-testid="blur-region-layer"]')
    await expect(blurLayer).not.toBeVisible()
    const badge = page.locator(`[data-testid="blur-region-indicator"][data-clip-id="${cid}"]`)
    await expect(badge).not.toBeVisible()

    // Move playhead onto the clip so the preview renders it.
    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    // Add a region via the store action.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(300)

    // Verify blur-region-layer appears with data-region-count="1".
    await expect(blurLayer).toBeVisible({ timeout: 5_000 })
    const regionCount = await blurLayer.getAttribute('data-region-count')
    expect(regionCount).toBe('1')

    // Verify data-track-id is set to the video track's id.
    const trackIdAttr = await blurLayer.getAttribute('data-track-id')
    expect(trackIdAttr).toBeTruthy()

    // Verify timeline badge appeared.
    await expect(badge).toBeVisible({ timeout: 5_000 })
  })

  // =========================================================================
  // (2) geometry: updateBlurRegion x/y/w/h → blur-region div CSS % updates.
  // =========================================================================
  test('(2) geometry: updateBlurRegion x/y/w/h → blur-region div CSS left/top/width/height %', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Move playhead onto the clip.
    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    // Add a region.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(200)

    // Get the region id from state.
    const regionId = await page.evaluate((cid) => {
      const clip = (() => {
        for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
          for (const c of t.clips)
            if ((c as Record<string, unknown>).id === cid) return c
        return null
      })()
      const regions = (clip as Record<string, unknown>)?.blurRegions as BlurRegion[] | undefined
      return regions?.[0]?.id ?? null
    }, cid)
    expect(regionId).toBeTruthy()

    // Update geometry.
    const newGeom = { x: 0.1, y: 0.2, w: 0.4, h: 0.35 }
    await page.evaluate(
      ({ cid, rid, g }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, g)
      },
      { cid, rid: regionId as string, g: newGeom }
    )
    await page.waitForTimeout(200)

    // Read the blur-region div styles.
    const regionDiv = page.locator('[data-testid="blur-region"]').first()
    await expect(regionDiv).toBeVisible({ timeout: 5_000 })

    const styles = await regionDiv.evaluate((el: HTMLElement) => ({
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      height: el.style.height
    }))

    // left = x * 100 = 10%, top = y * 100 = 20%, width = w * 100 = 40%, height = h * 100 = 35%
    expect(parseFloat(styles.left)).toBeCloseTo(newGeom.x * 100, 0)
    expect(parseFloat(styles.top)).toBeCloseTo(newGeom.y * 100, 0)
    expect(parseFloat(styles.width)).toBeCloseTo(newGeom.w * 100, 0)
    expect(parseFloat(styles.height)).toBeCloseTo(newGeom.h * 100, 0)
  })

  // =========================================================================
  // (3) effect toggle: update effect:'blur'/'mosaic' →
  //     data-region-effect flips; both produce a non-empty backdropFilter.
  // =========================================================================
  test('(3) effect toggle: blur/mosaic → data-region-effect flips; backdropFilter non-empty', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(200)

    const regionId = await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
        for (const c of t.clips)
          if ((c as Record<string, unknown>).id === cid) {
            const regions = (c as Record<string, unknown>).blurRegions as BlurRegion[] | undefined
            return regions?.[0]?.id ?? null
          }
      return null
    }, cid)
    expect(regionId).toBeTruthy()

    // Default is 'mosaic' — verify data-region-effect.
    const regionDiv = page.locator('[data-testid="blur-region"]').first()
    await expect(regionDiv).toBeVisible({ timeout: 5_000 })
    const initialEffect = await regionDiv.getAttribute('data-region-effect')
    expect(initialEffect).toBe('mosaic')

    // Verify mosaic backdropFilter is non-empty.
    const mosaicBdf = await regionDiv.evaluate((el: HTMLElement) =>
      el.style.backdropFilter || el.style.webkitBackdropFilter
    )
    expect(mosaicBdf).toBeTruthy()
    expect(mosaicBdf).toContain('blur(')

    // Toggle to 'blur'.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, { effect: 'blur' })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(200)

    const afterBlurEffect = await regionDiv.getAttribute('data-region-effect')
    expect(afterBlurEffect).toBe('blur')
    const blurBdf = await regionDiv.evaluate((el: HTMLElement) =>
      el.style.backdropFilter || el.style.webkitBackdropFilter
    )
    expect(blurBdf).toBeTruthy()
    expect(blurBdf).toContain('blur(')

    // Toggle back to 'mosaic'.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, { effect: 'mosaic' })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(200)

    const afterMosaicEffect = await regionDiv.getAttribute('data-region-effect')
    expect(afterMosaicEffect).toBe('mosaic')
  })

  // =========================================================================
  // (4) shape toggle: update shape:'ellipse' → data-region-shape="ellipse"
  //     + border-radius:50%.
  // =========================================================================
  test('(4) shape toggle: ellipse → data-region-shape="ellipse" + borderRadius:50%', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(200)

    const regionId = await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
        for (const c of t.clips)
          if ((c as Record<string, unknown>).id === cid) {
            const regions = (c as Record<string, unknown>).blurRegions as BlurRegion[] | undefined
            return regions?.[0]?.id ?? null
          }
      return null
    }, cid)
    expect(regionId).toBeTruthy()

    const regionDiv = page.locator('[data-testid="blur-region"]').first()
    await expect(regionDiv).toBeVisible({ timeout: 5_000 })

    // Default shape is 'rectangle' → borderRadius should be 0 (not 50%).
    const initialShape = await regionDiv.getAttribute('data-region-shape')
    expect(initialShape).toBe('rectangle')
    const initialBorderRadius = await regionDiv.evaluate((el: HTMLElement) => el.style.borderRadius)
    // rectangle: borderRadius is 0 or falsy (empty string).
    expect(initialBorderRadius === '0' || initialBorderRadius === '' || initialBorderRadius === '0px').toBe(true)

    // Update shape to ellipse.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, { shape: 'ellipse' })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(200)

    const afterShape = await regionDiv.getAttribute('data-region-shape')
    expect(afterShape).toBe('ellipse')

    const afterBorderRadius = await regionDiv.evaluate((el: HTMLElement) => el.style.borderRadius)
    expect(afterBorderRadius).toBe('50%')
  })

  // =========================================================================
  // (5) strength slider changes the backdropFilter magnitude.
  // =========================================================================
  test('(5) strength change → backdropFilter blur radius changes', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(200)

    const regionId = await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
        for (const c of t.clips)
          if ((c as Record<string, unknown>).id === cid) {
            const regions = (c as Record<string, unknown>).blurRegions as BlurRegion[] | undefined
            return regions?.[0]?.id ?? null
          }
      return null
    }, cid)
    expect(regionId).toBeTruthy()

    // Set to blur effect first so backdropFilter changes with strength directly.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, {
          effect: 'blur',
          strength: 10
        })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(200)

    const regionDiv = page.locator('[data-testid="blur-region"]').first()
    const bdfLow = await regionDiv.evaluate((el: HTMLElement) =>
      el.style.backdropFilter || el.style.webkitBackdropFilter
    )

    // Now set high strength.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, { strength: 90 })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(200)

    const bdfHigh = await regionDiv.evaluate((el: HTMLElement) =>
      el.style.backdropFilter || el.style.webkitBackdropFilter
    )

    // Both must contain a blur( value.
    expect(bdfLow).toContain('blur(')
    expect(bdfHigh).toContain('blur(')

    // The numeric radius must be higher at strength=90 than at strength=10.
    const extractPx = (s: string): number => {
      const m = s.match(/blur\(([0-9.]+)px\)/)
      return m ? parseFloat(m[1]) : 0
    }
    expect(extractPx(bdfHigh)).toBeGreaterThan(extractPx(bdfLow))
  })

  // =========================================================================
  // (6) multi-region: add 3 → 3 blur-region divs; region selector chips;
  //     menu-blur-add disabled at MAX_BLUR_REGIONS_PER_CLIP.
  // =========================================================================
  test('(6) multi-region: add 3 → 3 divs; menu-blur-add disabled at MAX=8', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    // Add 3 regions.
    for (let i = 0; i < 3; i++) {
      await page.evaluate((id) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
      }, cid)
      await page.waitForTimeout(100)
    }
    await page.waitForTimeout(200)

    // 3 blur-region divs must be visible.
    const blurDivs = page.locator('[data-testid="blur-region"]')
    await expect(blurDivs).toHaveCount(3, { timeout: 5_000 })

    // blur-region-layer data-region-count="3".
    const layer = page.locator('[data-testid="blur-region-layer"]')
    await expect(layer).toBeVisible()
    expect(await layer.getAttribute('data-region-count')).toBe('3')

    // Open context menu and blur panel to check selector chips (3 regions,
    // panel fits in viewport here).
    await openBlurPanel(cid)

    // There should be 3 region selector chips.
    const chipCount = await page.locator('[data-testid^="menu-blur-region-"]').count()
    expect(chipCount).toBe(3)

    // Close context menu (click elsewhere).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)

    // Add 5 more to reach MAX = 8 via the store.
    for (let i = 3; i < 8; i++) {
      await page.evaluate((id) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
      }, cid)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(200)

    // Verify store count is 8.
    const clip = await getClipFromState(cid)
    const regions = clip!.blurRegions as BlurRegion[] | undefined
    expect(regions?.length).toBe(8)

    // One more addBlurRegion should be a no-op (still 8) — store-level cap.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(100)
    const clipAfter = await getClipFromState(cid)
    expect((clipAfter!.blurRegions as BlurRegion[] | undefined)?.length).toBe(8)

    // Verify the menu-blur-add disabled state via the DOM attribute on the
    // button. Open the context menu, then use a JS click to bypass viewport
    // overflow (context menu with 8 region chips is taller than the window).
    const clipBlock = page.locator(`[data-testid="media-clip-block"][data-clip-id="${cid}"]`)
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="menu-blur"]')).toBeAttached({ timeout: 5_000 })
    // JS dispatch to open the panel regardless of viewport position.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="menu-blur"]') as HTMLElement | null
      if (el) el.click()
    })
    await expect(page.locator('[data-testid="menu-blur-panel"]')).toBeAttached({ timeout: 3_000 })

    // menu-blur-add must be disabled at cap — check via JS (element may be
    // off-screen when the region panel is taller than the viewport).
    const isDisabled = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="menu-blur-add"]') as HTMLButtonElement | null
      return btn ? btn.disabled : null
    })
    expect(isDisabled).toBe(true)

    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (7) remove: removeBlurRegion drops a region; removing the last →
  //     blur-region-layer + indicator gone (DOM byte-identical baseline).
  // =========================================================================
  test('(7) remove: last removal → blur-region-layer + indicator gone', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(300)

    // Add 2 regions.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(100)
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(200)

    // Grab region ids.
    const regionIds = await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
        for (const c of t.clips)
          if ((c as Record<string, unknown>).id === cid)
            return ((c as Record<string, unknown>).blurRegions as BlurRegion[] | undefined)?.map(r => r.id) ?? []
      return []
    }, cid)
    expect(regionIds.length).toBe(2)

    // Remove first region.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().removeBlurRegion(cid, rid)
      },
      { cid, rid: regionIds[0] }
    )
    await page.waitForTimeout(200)

    // 1 region left → blur-region-layer still visible with data-region-count="1".
    const layer = page.locator('[data-testid="blur-region-layer"]')
    await expect(layer).toBeVisible({ timeout: 5_000 })
    expect(await layer.getAttribute('data-region-count')).toBe('1')

    // Remove the last region.
    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().removeBlurRegion(cid, rid)
      },
      { cid, rid: regionIds[1] }
    )
    await page.waitForTimeout(300)

    // blur-region-layer must disappear entirely.
    await expect(layer).not.toBeVisible({ timeout: 5_000 })
    // blur-region-indicator badge must disappear.
    const badge = page.locator(`[data-testid="blur-region-indicator"][data-clip-id="${cid}"]`)
    await expect(badge).not.toBeVisible({ timeout: 5_000 })
    // No blur-region divs remain.
    const blurDivs = page.locator('[data-testid="blur-region"]')
    await expect(blurDivs).toHaveCount(0)
    // Store: blurRegions must be undefined (not []) after removing all.
    const clip = await getClipFromState(cid)
    expect(clip!.blurRegions).toBeUndefined()
  })

  // =========================================================================
  // (8) export with a mosaic rectangle region → filterGraph contains
  //     split + crop= + scale=...flags=neighbor + overlay=...:format=auto.
  // =========================================================================
  test('(8) export with mosaic rectangle: filterGraph has split + crop= + scale=flags=neighbor + overlay=format=auto', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Add a mosaic rectangle region (default).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
      // Default is mosaic + rectangle — no update needed.
    }, cid)
    await page.waitForTimeout(100)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-blur-mosaic.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPath }
    )

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // blur sub-chain must be present (br_ label namespace).
    expect(graph).toContain('br_')
    // split feeds into base + source copy.
    expect(graph).toContain('split=2[br_base_')
    // crop extracts the patch.
    expect(graph).toContain(`crop=`)
    // mosaic effect: scale down then up with neighbor flag.
    expect(graph).toContain('flags=neighbor')
    // overlay puts the processed patch back onto the base frame, format=auto.
    expect(graph).toContain(':format=auto')
  })

  // =========================================================================
  // (8b) export with ellipse blur region → filterGraph also has
  //      boxblur= + geq=.
  // =========================================================================
  test('(8b) export with ellipse blur: filterGraph has boxblur= + geq=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Add a blur + ellipse region.
    await page.evaluate((id) => {
      const store = window.__PROJECT_STORE_FOR_TEST__.getState()
      store.addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(100)

    // Get the region id and set effect=blur + shape=ellipse.
    const regionId = await page.evaluate((cid) => {
      for (const t of window.__PROJECT_STORE_FOR_TEST__.getState().project.tracks)
        for (const c of t.clips)
          if ((c as Record<string, unknown>).id === cid) {
            const regions = (c as Record<string, unknown>).blurRegions as BlurRegion[] | undefined
            return regions?.[0]?.id ?? null
          }
      return null
    }, cid)
    expect(regionId).toBeTruthy()

    await page.evaluate(
      ({ cid, rid }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().updateBlurRegion(cid, rid, {
          effect: 'blur',
          shape: 'ellipse'
        })
      },
      { cid, rid: regionId as string }
    )
    await page.waitForTimeout(100)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-blur-ellipse.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPath }
    )

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // blur effect: boxblur= present.
    expect(graph).toContain('boxblur=')
    // ellipse alpha mask: geq= present.
    expect(graph).toContain('geq=')
    // format=rgba before geq.
    expect(graph).toContain('format=rgba')
    // Overlay puts it back.
    expect(graph).toContain(':format=auto')
  })

  // =========================================================================
  // (9) REGRESSION: clip with no blurRegions → filterGraph has NO br_* labels.
  // =========================================================================
  test('(9) REGRESSION: clip with no blurRegions → filterGraph has no br_* labels', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-no-blur.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPath }
    )

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // No br_ labels from this feature.
    expect(graph).not.toContain('br_')
    // No geq from this feature (geq is used only for ellipse mask).
    expect(graph).not.toContain('geq=')
    // Standard pipeline intact (regression check).
    expect(graph).toContain('boxblur=20:1') // the blurred-bg pad filter
    expect(graph).toContain('scale=1080:1920')
  })

  // =========================================================================
  // (10) undo/redo: addBlurRegion → undo removes it → redo restores.
  // =========================================================================
  test('(10) undo/redo: addBlurRegion → undo removes → redo restores', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Baseline: no blurRegions.
    const baseline = await getClipFromState(cid)
    expect(baseline!.blurRegions).toBeUndefined()

    // Add a blur region; wait past zundo throttle.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(300)

    const withRegion = await getClipFromState(cid)
    expect((withRegion!.blurRegions as BlurRegion[] | undefined)?.length).toBe(1)

    // Undo.
    await page.evaluate(() => {
      window.__PROJECT_STORE_FOR_TEST__.temporal.getState().undo()
    })
    await page.waitForTimeout(200)

    const afterUndo = await getClipFromState(cid)
    // After undo, blurRegions should be undefined or empty.
    const afterUndoRegions = afterUndo!.blurRegions as BlurRegion[] | undefined
    expect(!afterUndoRegions || afterUndoRegions.length === 0).toBe(true)

    // Redo.
    await page.evaluate(() => {
      window.__PROJECT_STORE_FOR_TEST__.temporal.getState().redo()
    })
    await page.waitForTimeout(200)

    const afterRedo = await getClipFromState(cid)
    expect((afterRedo!.blurRegions as BlurRegion[] | undefined)?.length).toBe(1)
  })

  // =========================================================================
  // (11) region + transform: clip with both blurRegion AND non-identity
  //      transform → buildPlan ok, graph has blur sub-chain AND
  //      rotate= / colorchannelmixer=.
  // =========================================================================
  test('(11) region + transform: buildPlan ok, graph has blur sub-chain AND rotate=/colorchannelmixer=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Add a mosaic rectangle region.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().addBlurRegion(id)
    }, cid)
    await page.waitForTimeout(100)

    // Apply a non-identity transform (rotation + partial opacity).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipTransform(id, {
        rotation: 15,
        opacity: 0.75
      })
    }, cid)
    await page.waitForTimeout(100)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', 'plan-blur-transform.mp4')
    const result = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = (reels.state() as { project: unknown }).project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
      },
      { outputPath: outPath }
    )

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // Blur sub-chain.
    expect(graph).toContain('br_')
    expect(graph).toContain('split=2[br_base_')
    expect(graph).toContain('flags=neighbor')
    expect(graph).toContain(':format=auto')

    // Transform sub-chain.
    expect(graph).toContain('rotate=')
    expect(graph).toContain('colorchannelmixer=aa=')

    // CRITICAL ORDER: blur sub-chain (br_ labels) must appear BEFORE the
    // transform sub-chain (rotate=) — step 5.5 before step 6.
    const blurIdx = graph.indexOf('br_base_')
    const rotateIdx = graph.indexOf('rotate=')
    expect(blurIdx).toBeGreaterThanOrEqual(0)
    expect(rotateIdx).toBeGreaterThanOrEqual(0)
    expect(blurIdx).toBeLessThan(rotateIdx)
  })
})
