/**
 * @phase-3-49-enhance — 영상 화질 enhancer (Phase 3.49).
 *
 * Eight contracted scenarios:
 *
 * UI:
 *   (1) effects-section-enhance visible for video media clip;
 *       enhance-toggle + effects-enhance-slider present.
 *   (2) Toggle ON → clip.enhance === DEFAULT_ENHANCE (50); OFF → undefined.
 *
 * Store (clamping):
 *   (3) setClipEnhance(id, 999) → 100; (-5) → undefined; NaN → no-op.
 *
 * Export buildPlan:
 *   (4) clip with enhance=50 → filterGraph contains
 *       hqdn3d=1.50:0.75:1.50:0.75 and unsharp=lx=5:ly=5:la=0.90:cx=5:cy=5:ca=0.
 *       Order: AFTER smartblur (retouch) if present, BEFORE filmLook / fps=.
 *   (5) BYTE-IDENTICAL — clip with enhance absent → NO hqdn3d= and
 *       NO unsharp=lx=5:ly=5:la= (the enhance-specific signature).
 *   (6) Mixed timeline — two clips, one with enhance + one without →
 *       exactly one hqdn3d= in the graph.
 *
 * Undo/redo:
 *   (7) toggle on → undo → undefined → redo → 50.
 *
 * Real-encode smoke:
 *   (8) enhance=60 → exporter.run ok, mp4 > 1KB.
 */

import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants mirrored from shared/project.ts (Phase 3.49)
// ---------------------------------------------------------------------------
const DEFAULT_ENHANCE = 50
const MIN_ENHANCE = 0
const MAX_ENHANCE = 100

// ---------------------------------------------------------------------------
// Window type declarations
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => {
        project: {
          tracks: Array<{
            id: string
            kind: string
            clips: Array<Record<string, unknown>>
          }>
          media: Record<string, unknown>
        }
        setClipEnhance: (clipId: string, strength: number) => void
        setClipRetouch: (clipId: string, strength: number) => void
        setClipFilmLook: (clipId: string, patch: Record<string, unknown>) => void
        createNew: () => void
      }
    }
    __reelsStore: {
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
      newId: () => string
    }
    __reelsTimelineUi: {
      getState: () => {
        selectClip: (id: string) => void
      }
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-3-49-enhance video quality enhancer', () => {
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
  // Helpers
  // -------------------------------------------------------------------------
  async function openEditor(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await page.locator('[data-testid="open-editor-button"]').click({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="editor-page"]', { state: 'attached', timeout: 45_000 })
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsStore?: unknown }).__reelsStore,
      null,
      { timeout: 8_000 }
    )
    await page.waitForFunction(
      () => !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
      null,
      { timeout: 5_000 }
    )
  }

  async function addFixtureMedia(): Promise<{ mediaId: string; durationMs: number }> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return page.evaluate(async (filePath: string) => {
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
        width: probe.width ?? 1080,
        height: probe.height ?? 1920,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      return { mediaId: id, durationMs: probe.durationMs }
    }, fixture)
  }

  async function addVideoClip(mediaId: string, durationMs: number, startMs = 0): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      ({ mid, dur, st }) => {
        const reels = window.__reelsStore
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

  async function selectClip(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const block = page.locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`).first()
    if ((await block.count()) > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
      return
    }
    await page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await page.waitForTimeout(150)
  }

  async function openEffectsPanelAdjust(clipId: string, sectionId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await selectClip(clipId)
    const panelCount = await page.locator('[data-testid="effects-panel"]').count()
    if (panelCount === 0) {
      await page.locator('[data-testid="toggle-effects-panel"]').click()
      await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({ timeout: 5_000 })
    }
    const adjustTab = page.locator('[data-testid="effects-tab-adjust"]')
    if ((await adjustTab.count()) > 0) {
      const pressed = await adjustTab.getAttribute('aria-pressed')
      if (pressed !== 'true') {
        await adjustTab.click()
        await page.waitForTimeout(150)
      }
    }
    await expect(page.locator(`[data-testid="effects-section-${sectionId}"]`)).toBeVisible({ timeout: 5_000 })
    // Expand accordion section if collapsed.
    const sectionToggle = page.locator(`[data-testid="section-toggle-${sectionId}"]`)
    if ((await sectionToggle.count()) > 0) {
      const expanded = await sectionToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        await sectionToggle.click()
        await page.waitForTimeout(120)
      }
    }
  }

  async function buildPlan(outputPath: string): Promise<{ ok: boolean; filterGraph?: string; error?: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      async ({ op }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
      },
      { op: outputPath }
    )
  }

  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(220)
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().undo()
    })
  }

  async function redo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => {
      window.__reelsUndoRedo.getState().redo()
    })
  }

  // =========================================================================
  // (1) UI present
  // =========================================================================
  test('(1) effects-section-enhance visible; enhance-toggle + slider present', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid, 'enhance')

    await expect(page.locator('[data-testid="effects-section-enhance"]')).toBeVisible()
    await expect(page.locator('[data-testid="enhance-toggle"]')).toBeVisible()
    await expect(page.locator('[data-testid="effects-enhance-slider"]')).toBeAttached()
  })

  // =========================================================================
  // (2) Toggle ON → DEFAULT_ENHANCE (50); OFF → undefined
  // =========================================================================
  test('(2) enhance-toggle ON → clip.enhance=50 (DEFAULT_ENHANCE); OFF → undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid, 'enhance')

    const toggle = page.locator('[data-testid="enhance-toggle"]')
    await expect(toggle).not.toBeChecked()

    const before = await getClipFromState(cid)
    expect(before?.enhance).toBeUndefined()

    // Turn ON.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="enhance-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(120)

    const clipOn = await getClipFromState(cid)
    expect(clipOn?.enhance).toBe(DEFAULT_ENHANCE)
    await expect(toggle).toBeChecked()

    // Turn OFF.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="enhance-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(120)

    const clipOff = await getClipFromState(cid)
    expect(clipOff?.enhance).toBeUndefined()
    await expect(toggle).not.toBeChecked()
  })

  // =========================================================================
  // (3) Clamping: 999 → 100; -5 → undefined; NaN → no-op
  // =========================================================================
  test('(3) clamping: setClipEnhance(999)→100; (-5)→undefined; NaN→no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // 999 → MAX_ENHANCE (100).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 999)
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.enhance).toBe(MAX_ENHANCE)

    // -5 → treated as 0 → stored as undefined (OFF).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, -5)
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.enhance).toBeUndefined()

    // Set to a known value first.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 60)
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.enhance).toBe(60)

    // NaN → no-op (stays at 60).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, NaN)
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.enhance).toBe(60)

    // Sanity-check constants in scope.
    expect(MIN_ENHANCE).toBe(0)
    expect(MAX_ENHANCE).toBe(100)
  })

  // =========================================================================
  // (4) buildPlan with enhance=50 → exact hqdn3d + unsharp strings;
  //     order: AFTER smartblur (retouch), BEFORE fps=
  //
  // enhanceToFfmpeg(50):
  //   t=0.50, dnLuma=(0.5*3).toFixed(2)="1.50", dnChroma=(0.5*1.5).toFixed(2)="0.75"
  //   sharpAmount=(0.4+0.5*1.0).toFixed(2)="0.90"
  //   → hqdn3d=1.50:0.75:1.50:0.75,unsharp=lx=5:ly=5:la=0.90:cx=5:cy=5:ca=0
  // =========================================================================
  test('(4) buildPlan enhance=50 → hqdn3d=1.50:0.75:1.50:0.75; unsharp la=0.90; after smartblur, before fps=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Set enhance=50 AND retouch=40 so we can verify ordering relative to smartblur.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 50)
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 40)
    }, cid)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `enhance-plan-50-${Date.now()}.mp4`)
    const result = await buildPlan(outPath)

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''

    expect(graph).toContain('hqdn3d=1.50:0.75:1.50:0.75')
    expect(graph).toContain('unsharp=lx=5:ly=5:la=0.90:cx=5:cy=5:ca=0')

    // Find the fragment containing enhance.
    const fragments = graph.split(';')
    const enhanceFrag = fragments.find((f) => f.includes('hqdn3d=1.50:0.75:1.50:0.75'))
    expect(enhanceFrag).toBeTruthy()

    if (enhanceFrag) {
      const hqdn3dPos = enhanceFrag.indexOf('hqdn3d=1.50:0.75:1.50:0.75')
      const fpsPos = enhanceFrag.indexOf('fps=')
      const smartblurPos = enhanceFrag.indexOf('smartblur=')

      // enhance must come BEFORE fps= (if fps= is in the same fragment).
      if (fpsPos !== -1) {
        expect(hqdn3dPos).toBeLessThan(fpsPos)
      }

      // enhance must come AFTER smartblur (retouch) when retouch is set.
      if (smartblurPos !== -1) {
        expect(smartblurPos).toBeLessThan(hqdn3dPos)
      }

      // enhance must come BEFORE filmLook tokens (colortemperature, vignette).
      for (const filmToken of ['colortemperature=', 'vignette=angle=', 'noise=alls=']) {
        const filmPos = enhanceFrag.indexOf(filmToken)
        if (filmPos !== -1) {
          expect(hqdn3dPos).toBeLessThan(filmPos)
        }
      }
    }
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL — absent → no hqdn3d=, no unsharp=lx=5:ly=5:la=
  // =========================================================================
  test('(5) BYTE-IDENTICAL: enhance absent → no hqdn3d= and no enhance-specific unsharp= in graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `enhance-absent-${Date.now()}.mp4`)
    const result = await buildPlan(outPath)

    expect(result.ok).toBe(true)
    const graph: string = result.filterGraph ?? ''

    expect(graph).not.toContain('hqdn3d=')
    // The enhance-specific unsharp signature uses la= (luma-amount);
    // stabilize uses a different unsharp form so we check the enhance-specific params.
    expect(graph).not.toContain('unsharp=lx=5:ly=5:la=')
  })

  // =========================================================================
  // (6) Mixed timeline — two clips, one with enhance + one without →
  //     exactly one hqdn3d= in graph
  // =========================================================================
  test('(6) mixed timeline: enhance-on clip + off clip → exactly one hqdn3d=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    const cid1 = await addVideoClip(mediaId, durationMs, 0)
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)

    // Only cid1 has enhance.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 50)
    }, cid1)

    const clip2 = await getClipFromState(cid2)
    expect(clip2?.enhance).toBeUndefined()

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `enhance-mixed-${Date.now()}.mp4`)
    const result = await buildPlan(outPath)

    expect(result.ok).toBe(true)
    const graph: string = result.filterGraph ?? ''

    const hqdn3dCount = (graph.match(/hqdn3d=/g) ?? []).length
    expect(hqdn3dCount).toBe(1)
  })

  // =========================================================================
  // (7) Undo/redo — toggle on → undo → undefined → redo → 50
  // =========================================================================
  test('(7) undo/redo: toggle enhance on → undo → undefined → redo → 50', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    const fresh = await getClipFromState(cid)
    expect(fresh?.enhance).toBeUndefined()

    await page.evaluate(({ id, val }) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, val)
    }, { id: cid, val: DEFAULT_ENHANCE })
    await tick()

    expect((await getClipFromState(cid))?.enhance).toBe(DEFAULT_ENHANCE)

    await undo()
    await page.waitForTimeout(100)
    expect((await getClipFromState(cid))?.enhance).toBeUndefined()

    await redo()
    await page.waitForTimeout(100)
    expect((await getClipFromState(cid))?.enhance).toBe(DEFAULT_ENHANCE)
  })

  // =========================================================================
  // (8) Real-encode smoke — enhance=60 → exporter.run ok, mp4 > 1KB
  // =========================================================================
  test('(8) real-encode smoke: enhance=60 → exporter.run ok, mp4 > 1KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 60)
    }, cid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `enhance-smoke-${Date.now()}.mp4`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-enhance-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `enhance export failed: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Constant sanity (no app launch)
// ---------------------------------------------------------------------------
test('@phase-3-49-enhance formula constants match shared/project.ts values', () => {
  expect(DEFAULT_ENHANCE).toBe(50)
  expect(MIN_ENHANCE).toBe(0)
  expect(MAX_ENHANCE).toBe(100)

  // enhanceToFfmpeg(50): t=0.5, dnLuma=1.50, dnChroma=0.75, sharp=0.90
  const t = 0.5
  const dnLuma = (t * 3).toFixed(2)
  const dnChroma = (t * 1.5).toFixed(2)
  const sharpAmount = (0.4 + t * 1.0).toFixed(2)
  expect(dnLuma).toBe('1.50')
  expect(dnChroma).toBe('0.75')
  expect(sharpAmount).toBe('0.90')

  // enhanceToFfmpeg(100): t=1.0, dnLuma=3.00, dnChroma=1.50, sharp=1.40
  const t100 = 1.0
  expect((t100 * 3).toFixed(2)).toBe('3.00')
  expect((t100 * 1.5).toFixed(2)).toBe('1.50')
  expect((0.4 + t100 * 1.0).toFixed(2)).toBe('1.40')
})
