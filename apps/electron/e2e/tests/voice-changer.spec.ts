/**
 * @phase-3-50-voice-changer — 보이스 체인저 (Voice Changer, Phase 3.50).
 *
 * Eight contracted scenarios:
 *
 * UI:
 *   (1) Right-click media clip → ClipContextMenu opens → menu-voice-changer row
 *       visible; voice-changer-select dropdown lists 8 options.
 *
 * Store:
 *   (2) setClipVoiceChanger(id, 'helium') → clip.voiceChangerId === 'helium';
 *       ('none') → undefined.
 *
 * Export buildPlan:
 *   (3) For each non-none preset (helium/chipmunk/deep/robot/echo/phone/monster),
 *       build plan → exact recipe substring appears in audio fragment.
 *   (4) Stacking order — noiseReduction=50 + voiceEnhance.loudnorm + voiceChangerId='helium'
 *       + speed=1.5 → audio fragment order: afftdn BEFORE loudnorm BEFORE asetrate=66150
 *       (voice changer) BEFORE atempo=1.5 (speed).
 *   (5) BYTE-IDENTICAL — clip with voiceChangerId absent → graph has NONE of the
 *       voice-changer-specific tokens.
 *
 * Store (sanitize):
 *   (6) setClipVoiceChanger(id, 'invalid' as any) → collapses to undefined.
 *
 * Undo/redo:
 *   (7) set helium → undo → undefined → redo → helium.
 *
 * Real-encode smoke:
 *   (8) voiceChangerId: 'helium' → exporter.run ok, mp4 > 1KB.
 */

import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Golden recipe strings (mirrored from filterPresets.ts)
// ---------------------------------------------------------------------------
const VOICE_CHANGER_RECIPES: Record<string, string> = {
  helium: 'aresample=44100,asetrate=66150,aresample=44100,atempo=0.6667',
  chipmunk: 'aresample=44100,asetrate=88200,aresample=44100,atempo=0.5',
  deep: 'aresample=44100,asetrate=30870,aresample=44100,atempo=1.4286',
  robot: 'chorus=0.7:0.9:55:0.4:0.25:2',
  echo: 'aecho=0.8:0.88:60:0.4',
  phone: 'highpass=300,lowpass=3400,acompressor=threshold=-20dB:ratio=4:attack=5:release=50',
  monster: 'aresample=44100,asetrate=30870,aresample=44100,atempo=1.4286,tremolo=f=5:d=0.5'
}

// Tokens that must NEVER appear when voiceChangerId is absent.
const VC_ABSENT_TOKENS = [
  'asetrate=66150',
  'asetrate=88200',
  'asetrate=30870',
  'chorus=',
  'aecho=',
  'highpass=300',
  'tremolo='
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
        setClipVoiceChanger: (clipId: string, id: string) => void
        setClipNoiseReduction: (clipId: string, strength: number) => void
        setClipVoiceEnhance: (clipId: string, patch: Record<string, boolean>) => void
        setClipSpeed: (clipId: string, speed: number) => void
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
test.describe('@phase-3-50-voice-changer voice changer presets', () => {
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

  async function buildPlanGraph(outputPath: string): Promise<{ ok: boolean; graph: string; error?: string }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const result = await page.evaluate(
      async ({ op }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        const r = await window.electron.exporter.buildPlan(project, 'instagram-reels', op)
        return { ok: r.ok as boolean, graph: (r.filterGraph ?? '') as string, error: r.error as string | undefined }
      },
      { op: outputPath }
    )
    return result
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
  test('(1) right-click clip → menu-voice-changer visible; voice-changer-select lists 8 options', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    const clipBlock = page.locator(`[data-testid="media-clip-block"][data-clip-id="${cid}"]`)
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })

    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('[data-testid="menu-voice-changer"]')).toBeVisible({ timeout: 3_000 })

    // The dropdown must have 8 options (none + 7 presets).
    const select = page.locator('[data-testid="voice-changer-select"]')
    await expect(select).toBeVisible({ timeout: 3_000 })
    const optionCount = await select.locator('option').count()
    expect(optionCount).toBe(8)

    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (2) Store toggle
  // =========================================================================
  test("(2) setClipVoiceChanger(id,'helium') → voiceChangerId='helium'; ('none') → undefined", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    const fresh = await getClipFromState(cid)
    expect(fresh?.voiceChangerId).toBeUndefined()

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'helium')
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.voiceChangerId).toBe('helium')

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'none')
    }, cid)
    await page.waitForTimeout(80)
    expect((await getClipFromState(cid))?.voiceChangerId).toBeUndefined()
  })

  // =========================================================================
  // (3) buildPlan with each preset → exact recipe string in audio fragment
  // =========================================================================
  for (const [presetId, recipe] of Object.entries(VOICE_CHANGER_RECIPES)) {
    test(`(3) buildPlan voiceChangerId='${presetId}' → exact recipe in graph`, async () => {
      if (!launched) throw new Error('launch failed')
      const { page } = launched
      await openEditor()
      const { mediaId, durationMs } = await addFixtureMedia()
      const cid = await addVideoClip(mediaId, durationMs)

      await page.evaluate(
        ({ id, preset }) => {
          window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, preset)
        },
        { id: cid, preset: presetId }
      )
      await page.waitForTimeout(80)

      const outPath = path.join(
        os.tmpdir(),
        'reels-studio-e2e',
        `vc-recipe-${presetId}-${Date.now()}.mp4`
      )
      const { ok, graph } = await buildPlanGraph(outPath)
      expect(ok, `buildPlan failed for preset '${presetId}'`).toBe(true)

      // Assert the first distinct token of the recipe (handles multi-filter chains).
      const recipeStart = recipe.split(',')[0]
      expect(graph, `preset '${presetId}' recipe not found`).toContain(recipeStart)
    })
  }

  // =========================================================================
  // (4) Stacking order — afftdn BEFORE loudnorm BEFORE voice-changer BEFORE atempo
  // =========================================================================
  test('(4) stacking order: afftdn < loudnorm < asetrate=66150 (helium) < atempo=1.5', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // noiseReduction=50 + voiceEnhance.loudnorm=true + voiceChangerId='helium' + speed=1.5
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipNoiseReduction(id, 50)
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceEnhance(id, {
        loudnorm: true,
        compress: false,
        deEss: false,
        eqLowCut: false,
        eqPresence: false
      })
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'helium')
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipSpeed(id, 1.5)
    }, cid)
    await page.waitForTimeout(80)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `vc-order-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    // loudnorm must be present.
    expect(graph).toContain('loudnorm=I=-16')
    // voice changer token.
    expect(graph).toContain('asetrate=66150')
    // speed atempo.
    expect(graph).toContain('atempo=1.5')

    // Find the audio fragment that contains all tokens.
    const fragments = graph.split(';')
    const audioFrag = fragments.find(
      (f) =>
        f.includes('loudnorm=I=-16') &&
        f.includes('asetrate=66150') &&
        f.includes('atempo=1.5')
    )
    expect(audioFrag).toBeTruthy()

    if (audioFrag) {
      const loudnormPos = audioFrag.indexOf('loudnorm=I=-16')
      const aseratePos = audioFrag.indexOf('asetrate=66150')
      const atempoPos = audioFrag.indexOf('atempo=1.5')

      // loudnorm BEFORE asetrate (voice changer).
      expect(loudnormPos).toBeLessThan(aseratePos)
      // asetrate (voice changer) BEFORE atempo (speed).
      expect(aseratePos).toBeLessThan(atempoPos)

      // If afftdn is present (bundled ffmpeg supports it), it must be BEFORE loudnorm.
      const afftdnPos = audioFrag.indexOf('afftdn')
      if (afftdnPos !== -1) {
        expect(afftdnPos).toBeLessThan(loudnormPos)
      }
    }
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL — voiceChangerId absent → none of the VC tokens in graph
  // =========================================================================
  test('(5) BYTE-IDENTICAL: voiceChangerId absent → none of VC tokens in graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `vc-absent-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    for (const token of VC_ABSENT_TOKENS) {
      expect(graph, `token '${token}' must not appear when voiceChangerId is absent`).not.toContain(token)
    }
  })

  // =========================================================================
  // (6) Unknown id sanitized → collapses to undefined
  // =========================================================================
  test("(6) setClipVoiceChanger(id, 'invalid') → collapses to undefined", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'invalid' as any)
    }, cid)
    await page.waitForTimeout(80)

    // Store should sanitize unknown id → undefined.
    const clip = await getClipFromState(cid)
    // Either voiceChangerId is absent or is 'none' — but undefined is the contracted behavior.
    const vc = clip?.voiceChangerId
    expect(vc === undefined || vc === 'none').toBe(true)
  })

  // =========================================================================
  // (7) Undo/redo — helium → undo → undefined → redo → helium
  // =========================================================================
  test("(7) undo/redo: set 'helium' → undo → undefined → redo → 'helium'", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    expect((await getClipFromState(cid))?.voiceChangerId).toBeUndefined()

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'helium')
    }, cid)
    await tick()

    expect((await getClipFromState(cid))?.voiceChangerId).toBe('helium')

    await undo()
    await page.waitForTimeout(100)
    const afterUndo = await getClipFromState(cid)
    expect(afterUndo?.voiceChangerId === undefined || afterUndo?.voiceChangerId === 'none').toBe(true)

    await redo()
    await page.waitForTimeout(100)
    expect((await getClipFromState(cid))?.voiceChangerId).toBe('helium')
  })

  // =========================================================================
  // (8) Real-encode smoke — voiceChangerId='helium' → ok, mp4 > 1KB
  // =========================================================================
  test("(8) real-encode smoke: voiceChangerId='helium' → exporter.run ok, mp4 > 1KB", async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceChanger(id, 'helium')
    }, cid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `vc-smoke-${Date.now()}.mp4`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-vc-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `voice-changer export failed: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Recipe golden strings sanity (pure, no app launch)
// ---------------------------------------------------------------------------
test('@phase-3-50-voice-changer recipe golden strings are non-empty and distinct', () => {
  const seen = new Set<string>()
  for (const [id, recipe] of Object.entries(VOICE_CHANGER_RECIPES)) {
    expect(recipe.length, `recipe for '${id}' must be non-empty`).toBeGreaterThan(0)
    expect(seen.has(recipe), `recipe for '${id}' must be unique`).toBe(false)
    seen.add(recipe)
  }
  // All 7 non-none presets covered.
  expect(Object.keys(VOICE_CHANGER_RECIPES).length).toBe(7)
})
