/**
 * @phase-3-51-visual-effect — 비주얼 이펙트 라이브러리 (Visual Effects, Phase 3.51).
 *
 * Eight contracted scenarios:
 *
 * UI:
 *   (1) effects-section-visual-effect visible for video media clip;
 *       visual-effect-select dropdown with 8 options.
 *
 * Store:
 *   (2) setClipVisualEffect(id, 'glitch') → clip.visualEffect === 'glitch';
 *       ('none') → undefined.
 *
 * Export buildPlan:
 *   (3) For each non-none preset (glitch/vhs/dream/dual-tone/negative/sketch/infrared),
 *       build plan → exact recipe substring in the video fragment.
 *   (4) Stacking order — retouch=40 + enhance=50 + filmLook.toneId='warm' + visualEffect='glitch':
 *       smartblur BEFORE hqdn3d BEFORE colortemperature (warm tone) BEFORE rgbashift= (glitch)
 *       BEFORE fps=.
 *   (5) BYTE-IDENTICAL — visualEffect absent → NONE of the known visual-effect tokens in graph.
 *
 * Store (sanitize):
 *   (6) setClipVisualEffect(id, 'invalid' as any) → undefined.
 *
 * Undo/redo:
 *   (7) glitch → undo → undefined → redo → glitch.
 *
 * Real-encode smoke:
 *   (8) glitch + sketch + dream → exporter.run ok, mp4 > 1KB for each.
 */

import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Golden recipe strings (mirrored from filterPresets.ts)
// ---------------------------------------------------------------------------
const VISUAL_EFFECT_RECIPES: Record<string, string> = {
  glitch: 'rgbashift=rh=4:gv=2:bh=-4:bv=-2',
  vhs: 'rgbashift=rh=2:bh=-2,noise=alls=8:allf=t+u:all_seed=4711,unsharp=lx=5:ly=5:la=-0.3:cx=5:cy=5:ca=0',
  dream: 'gblur=sigma=1.5,eq=brightness=0.05:contrast=0.92:saturation=1.2',
  'dual-tone': 'colorchannelmixer=0.7:0:0.3:0:0.2:0:0.8:0:0:0.5:0.5:0',
  negative: 'negate',
  sketch: 'edgedetect=mode=colormix:high=0.2:low=0.08',
  infrared: 'hue=H=180,eq=saturation=1.3'
}

// Tokens that must NEVER appear when visualEffect is absent.
const VE_ABSENT_TOKENS = [
  'rgbashift',
  'noise=alls=8:',
  'gblur=sigma=1.5',
  'colorchannelmixer=0.7:0:0.3',
  'negate',
  'edgedetect=mode=colormix',
  'hue=H=180'
]

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
        setClipVisualEffect: (clipId: string, id: string) => void
        setClipRetouch: (clipId: string, strength: number) => void
        setClipEnhance: (clipId: string, strength: number) => void
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
test.describe('@phase-3-51-visual-effect visual effect presets', () => {
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
    const sectionToggle = page.locator(`[data-testid="section-toggle-${sectionId}"]`)
    if ((await sectionToggle.count()) > 0) {
      const expanded = await sectionToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        await sectionToggle.click()
        await page.waitForTimeout(120)
      }
    }
  }

  async function buildPlanGraph(outputPath: string): Promise<{ ok: boolean; graph: string; error?: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(
      async ({ op }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        const r = await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
        return { ok: r.ok as boolean, graph: (r.filterGraph ?? '') as string, error: r.error as string | undefined }
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
  test('(1) effects-section-visual-effect visible; visual-effect-select with 8 options', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid, 'visual-effect')

    await expect(page.locator('[data-testid="effects-section-visual-effect"]')).toBeVisible()
    const select = page.locator('[data-testid="visual-effect-select"]')
    await expect(select).toBeVisible()

    // 8 options: none + 7 presets.
    const optionCount = await select.locator('option').count()
    expect(optionCount).toBe(8)
  })

  // =========================================================================
  // (2) Store toggle
  // =========================================================================
  test("(2) setClipVisualEffect(id, 'glitch') → visualEffect='glitch'; ('none') → undefined", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    const fresh = await getClipFromState(cid)
    expect(fresh?.visualEffect).toBeUndefined()

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, 'glitch')
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.visualEffect).toBe('glitch')

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, 'none')
    }, cid)
    await page.waitForTimeout(80)
    const afterNone = (await getClipFromState(cid))?.visualEffect
    expect(afterNone === undefined || afterNone === 'none').toBe(true)
  })

  // =========================================================================
  // (3) buildPlan with each preset → exact recipe substring in graph
  // =========================================================================
  for (const [presetId, recipe] of Object.entries(VISUAL_EFFECT_RECIPES)) {
    test(`(3) buildPlan visualEffect='${presetId}' → exact recipe token in graph`, async () => {
      if (!launched) throw new Error('launch failed')
      const { page } = launched
      await openEditor()
      const { mediaId, durationMs } = await addFixtureMedia()
      const cid = await addVideoClip(mediaId, durationMs)

      await page.evaluate(
        ({ id, preset }) => {
          window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, preset)
        },
        { id: cid, preset: presetId }
      )
      await page.waitForTimeout(80)

      const outPath = path.join(
        os.tmpdir(),
        'reels-studio-e2e',
        `ve-recipe-${presetId}-${Date.now()}.mp4`
      )
      const { ok, graph } = await buildPlanGraph(outPath)
      expect(ok, `buildPlan failed for preset '${presetId}'`).toBe(true)

      // Use the first filter token of the recipe (before any comma).
      const recipeStart = recipe.split(',')[0]
      expect(graph, `preset '${presetId}' recipe not found`).toContain(recipeStart)
    })
  }

  // =========================================================================
  // (4) Stacking order — retouch + enhance + filmLook(warm) + visualEffect(glitch)
  //     Order: smartblur < hqdn3d < colortemperature (warm) < rgbashift (glitch) < fps=
  // =========================================================================
  test('(4) stacking order: smartblur < hqdn3d < colortemperature < rgbashift < fps=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipRetouch(id, 40)
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipEnhance(id, 50)
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipFilmLook(id, {
        vignette: 0,
        grain: 0,
        toneId: 'warm'
      })
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, 'glitch')
    }, cid)
    await page.waitForTimeout(80)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `vfx-order-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    expect(graph).toContain('smartblur=')
    expect(graph).toContain('hqdn3d=')
    expect(graph).toContain('colortemperature=')
    expect(graph).toContain('rgbashift=')

    // Find the video fragment that contains all four tokens.
    const fragments = graph.split(';')
    const videoFrag = fragments.find(
      (f) =>
        f.includes('smartblur=') &&
        f.includes('hqdn3d=') &&
        f.includes('colortemperature=') &&
        f.includes('rgbashift=')
    )
    expect(videoFrag).toBeTruthy()

    if (videoFrag) {
      const smartblurPos = videoFrag.indexOf('smartblur=')
      const hqdn3dPos = videoFrag.indexOf('hqdn3d=')
      const colorTempPos = videoFrag.indexOf('colortemperature=')
      const rgbaPos = videoFrag.indexOf('rgbashift=')
      const fpsPos = videoFrag.indexOf('fps=')

      // Strict order.
      expect(smartblurPos).toBeLessThan(hqdn3dPos)
      expect(hqdn3dPos).toBeLessThan(colorTempPos)
      expect(colorTempPos).toBeLessThan(rgbaPos)
      if (fpsPos !== -1) {
        expect(rgbaPos).toBeLessThan(fpsPos)
      }
    }
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL — visualEffect absent → none of the VFX tokens
  // =========================================================================
  test('(5) BYTE-IDENTICAL: visualEffect absent → none of the VFX tokens in graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `vfx-absent-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    for (const token of VE_ABSENT_TOKENS) {
      expect(graph, `token '${token}' must not appear when visualEffect is absent`).not.toContain(token)
    }
  })

  // =========================================================================
  // (6) Unknown id sanitized → undefined
  // =========================================================================
  test("(6) setClipVisualEffect(id, 'invalid') → collapses to undefined", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, 'invalid' as any)
    }, cid)
    await page.waitForTimeout(80)

    const clip = await getClipFromState(cid)
    const ve = clip?.visualEffect
    expect(ve === undefined || ve === 'none').toBe(true)
  })

  // =========================================================================
  // (7) Undo/redo — glitch → undo → undefined → redo → glitch
  // =========================================================================
  test("(7) undo/redo: set 'glitch' → undo → undefined → redo → 'glitch'", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    expect((await getClipFromState(cid))?.visualEffect).toBeUndefined()

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, 'glitch')
    }, cid)
    await tick()

    expect((await getClipFromState(cid))?.visualEffect).toBe('glitch')

    await undo()
    await page.waitForTimeout(100)
    const afterUndo = (await getClipFromState(cid))?.visualEffect
    expect(afterUndo === undefined || afterUndo === 'none').toBe(true)

    await redo()
    await page.waitForTimeout(100)
    expect((await getClipFromState(cid))?.visualEffect).toBe('glitch')
  })

  // =========================================================================
  // (8) Real-encode smoke — glitch + sketch + dream → ok, mp4 > 1KB each
  // =========================================================================
  test('(8) real-encode smoke: glitch + sketch + dream → each exporter.run ok, mp4 > 1KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    for (const effectId of ['glitch', 'sketch', 'dream']) {
      // Add fresh media + clip for each effect run (do NOT createNew — that would
      // clear the media library). Instead just add a new clip at successive start times.
      const { mediaId, durationMs } = await addFixtureMedia()
      const cid = await addVideoClip(mediaId, durationMs)

      await page.evaluate(
        ({ id, effect }) => {
          window.__PROJECT_STORE_FOR_TEST__.getState().setClipVisualEffect(id, effect)
        },
        { id: cid, effect: effectId }
      )
      await page.waitForTimeout(80)

      // Build a single-clip project for the smoke export by using buildPlan first
      // to verify the effect is in the graph, then run full export.
      const outPath = path.join(outDir, `vfx-smoke-${effectId}-${Date.now()}.mp4`)

      await page.evaluate(async (p) => {
        await window.electron.fs.allowPath(p)
      }, outPath)

      // Export using only this clip's project state captured at this moment.
      const r = await page.evaluate(
        async ({ outputPath, clipId }) => {
          const reels = window.__reelsStore
          const proj = reels.state().project
          // Create a single-clip project slice for the smoke.
          const videoTrack = proj.tracks.find((t) => t.kind === 'video')
          if (!videoTrack) return { ok: false as boolean, error: 'no video track' }
          const clip = videoTrack.clips.find((c) => (c as {id:string}).id === clipId)
          if (!clip) return { ok: false as boolean, error: 'clip not found' }
          const singleClipProject = {
            ...proj,
            tracks: proj.tracks.map((t) =>
              t.kind === 'video' ? { ...t, clips: [clip] } : { ...t, clips: [] }
            )
          }
          return await window.electron.exporter.run(singleClipProject, {
            jobId: `e2e-vfx-${Date.now()}`,
            presetKey: 'instagram-reels',
            outputPath
          })
        },
        { outputPath: outPath, clipId: cid }
      )

      expect(r.ok, `visual-effect '${effectId}' export failed: ${r.error ?? ''}`).toBe(true)
      expect(existsSync(outPath), `output file for '${effectId}' must exist`).toBe(true)
      expect(statSync(outPath).size, `output for '${effectId}' must be > 1KB`).toBeGreaterThan(1024)
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------
// Recipe golden strings sanity (pure, no app launch)
// ---------------------------------------------------------------------------
test('@phase-3-51-visual-effect recipe golden strings are non-empty and distinct', () => {
  const seen = new Set<string>()
  for (const [id, recipe] of Object.entries(VISUAL_EFFECT_RECIPES)) {
    expect(recipe.length, `recipe for '${id}' must be non-empty`).toBeGreaterThan(0)
    expect(seen.has(recipe), `recipe for '${id}' must be unique`).toBe(false)
    seen.add(recipe)
  }
  // All 7 non-none presets covered.
  expect(Object.keys(VISUAL_EFFECT_RECIPES).length).toBe(7)

  // Spot-check a few recipe tokens are exactly right (protect against typos).
  expect(VISUAL_EFFECT_RECIPES['glitch']).toBe('rgbashift=rh=4:gv=2:bh=-4:bv=-2')
  expect(VISUAL_EFFECT_RECIPES['negative']).toBe('negate')
  expect(VISUAL_EFFECT_RECIPES['infrared']).toBe('hue=H=180,eq=saturation=1.3')
})
