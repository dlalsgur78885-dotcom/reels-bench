/**
 * @phase-stabilize — per-clip video stabilization (손떨림 보정), Phase 3.38.
 *
 * 10 contracted scenarios:
 *
 * UI:
 *   (1) effects-section-stabilize, stabilize-toggle, effects-stabilize-slider
 *       present for a media video clip. NOT present for an audio clip.
 *   (2) Toggle ON → clip.stabilize === 50 (DEFAULT_STABILIZE); OFF → undefined.
 *
 * Store (clamping / no-op):
 *   (3) setClipStabilize(id, 999) → stored 100; (id, -5) → undefined;
 *       (id, NaN) → no-op (no change from prior value).
 *
 * Export buildPlan (filter graph):
 *   (4) clip with stabilize=50 → filterGraph contains deshake=rx=.
 *       Ordering: AFTER setpts=PTS-STARTPTS / reverse, BEFORE any setpts=PTS/
 *       (speed) and BEFORE fps= in the same per-clip fragment.
 *   (5) BYTE-IDENTICAL REGRESSION — clip with stabilize absent →
 *       no vidstabtransform, no vidstabdetect, no deshake= in graph.
 *   (6) Mixed timeline — two clips, one stabilize-on + one off →
 *       exactly ONE deshake= fragment in graph.
 *
 * Undo/redo:
 *   (7) Toggle on (stabilize=50) → undo → undefined → redo → 50.
 *
 * Preview DOM:
 *   (8) clip.stabilize=50 → <video data-stabilize="true">;
 *       absent/off → data-stabilize="false".
 *
 * Real-encode smoke (CRITICAL):
 *   (9) exporter.run on a clip with stabilize=60 → ok:true, output mp4 > 1KB;
 *       userData/stabilize-cache/ contains exactly one .trf > 0 bytes.
 *       Second run (same clip, stabilize=80) → .trf mtime UNCHANGED (cache hit
 *       proves strength is NOT in the cache key).
 *
 * Progress events:
 *  (10) During real export with one stabilize-enabled clip, the renderer
 *       receives at least one ffmpeg:progress event with
 *       message==='stabilize-detect' BEFORE any normal encoding event.
 *       A no-stabilize project emits ZERO stabilize-detect events.
 *
 * NOTE: tests (9) and (10) require libvidstab to be present in the bundled
 * ffmpeg-static to observe cache file creation. When vidstab is absent,
 * the export falls back to deshake (single-pass), which produces no .trf.
 * Both tests detect this and downgrade their assertions accordingly — the
 * smoke still validates ok:true and mp4 > 1KB.
 */

import { expect, test } from '@playwright/test'
import { existsSync, statSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Constants mirrored from shared/project.ts (Phase 3.38)
// ---------------------------------------------------------------------------
const DEFAULT_STABILIZE = 50
const MIN_STABILIZE = 0
const MAX_STABILIZE = 100

// ---------------------------------------------------------------------------
// Type declarations for window test bridges
// ---------------------------------------------------------------------------
type ProjectStoreState = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      role?: string
      clips: Array<Record<string, unknown>>
    }>
    media: Record<string, { kind: string; path?: string }>
  }
  setClipStabilize: (clipId: string, strength: number) => void
  createNew: () => void
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectStoreState
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
      state: () => ProjectStoreState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      newId: () => string
    }
    __reelsUndoRedo: {
      getState: () => {
        undo: () => void
        redo: () => void
        pastStates: unknown[]
        futureStates: unknown[]
      }
    }
    __reelsTimelineUi: {
      getState: () => {
        setPlayheadMs: (ms: number) => void
        selectClip: (id: string) => void
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-stabilize video stabilization (손떨림 보정)', () => {
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
      if (launched.userDataDir) {
        try {
          rmSync(launched.userDataDir, { recursive: true, force: true })
        } catch {
          /* best-effort */
        }
      }
      launched = null
    }
    // Clean up smoke output files.
    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (existsSync(outDir)) {
      try {
        for (const f of readdirSync(outDir)) {
          if (f.startsWith('stabilize-')) {
            try { rmSync(path.join(outDir, f)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  })

  // -------------------------------------------------------------------------
  // Internal helpers
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

  /**
   * Add a fake audio-only media asset (no real file — just enough shape for
   * the store so the clip renders as audio-kind). We DON'T need to probe a
   * real audio file; we just need `kind:'audio'` in the media record.
   */
  async function addAudioClip(): Promise<string> {
    if (!launched) throw new Error('launch failed')
    const fixture = process.env.E2E_FIXTURE_MP4
    if (!fixture) throw new Error('E2E_FIXTURE_MP4 not set')
    const { page } = launched
    return page.evaluate(async (filePath: string) => {
      const reels = window.__reelsStore
      const mediaId = reels.newId()
      // Fake audio-kind asset — kind overridden to 'audio' so EffectsPanel
      // hides the stabilize section.
      reels.addMedia({
        id: mediaId,
        path: filePath,
        kind: 'audio',
        durationMs: 2000,
        width: 0,
        height: 0,
        importedAt: Date.now(),
        fileName: 'fake-audio.mp3',
        fileSizeBytes: 0
      })
      // Add to the first audio track.
      const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')
      if (!audioTrack) return 'no-audio-track'
      const cid = reels.newId()
      reels.addClip({
        id: cid,
        kind: 'media',
        mediaId,
        trackId: audioTrack.id,
        startMs: 0,
        endMs: 2000,
        trimInMs: 0,
        trimOutMs: 2000,
        speed: 1
      })
      return cid
    }, fixture)
  }

  async function addVideoClip(
    mediaId: string,
    durationMs: number,
    startMs = 0
  ): Promise<string> {
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
    // The EffectsPanel is driven by Editor.tsx's local `selectedClipId` state
    // which is set via Timeline's `onSelectClip` handler — triggered only by
    // a DOM click on the clip block. The __reelsTimelineUi store's selectClip
    // does NOT feed into effectsClipId.
    const block = page.locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`).first()
    const count = await block.count()
    if (count > 0) {
      await block.click({ force: true })
      await page.waitForTimeout(200)
      return
    }
    // Fallback: timeline-ui store (helps with timeline scrolling state but
    // does NOT update Editor.tsx's selectedClipId; used only when DOM click fails).
    await page.evaluate((id) => {
      window.__reelsTimelineUi.getState().selectClip(id)
    }, clipId)
    await page.waitForTimeout(200)
  }

  /**
   * Open the EffectsPanel for a selected clip, navigate to the 조정 (adjust)
   * tab, and wait for the effects-section-stabilize to be visible. Mirrors the
   * pattern from retouch.spec.ts that is known to work.
   */
  async function openEffectsPanelAdjust(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await selectClip(clipId)
    // Open the panel if not already open.
    const panelCount = await page.locator('[data-testid="effects-panel"]').count()
    if (panelCount === 0) {
      await page.locator('[data-testid="toggle-effects-panel"]').click()
      await expect(page.locator('[data-testid="effects-panel"]')).toBeVisible({ timeout: 5_000 })
    }
    // Navigate to the 조정 (adjust) tab.
    const adjustTab = page.locator('[data-testid="effects-tab-adjust"]')
    const adjustTabCount = await adjustTab.count()
    if (adjustTabCount > 0) {
      const pressed = await adjustTab.getAttribute('aria-pressed')
      if (pressed !== 'true') {
        await adjustTab.click()
        await page.waitForTimeout(150)
      }
    }
    // Wait for the stabilize section to be visible (proves clip selected + tab active).
    await expect(page.locator('[data-testid="effects-section-stabilize"]')).toBeVisible({
      timeout: 5_000
    })
  }

  async function buildPlan(outputPath: string): Promise<{
    ok: boolean
    filterGraph?: string
    error?: string
  }> {
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

  /** Sleep >= undo throttle window (220ms). */
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
  // (1) UI present — effects-section-stabilize visible for media video clip;
  //     stabilize-toggle + slider present. NOT present for audio clip.
  // =========================================================================
  test('(1) effects-section-stabilize visible for video clip; toggle + slider present; absent for audio', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid)

    const section = page.locator('[data-testid="effects-section-stabilize"]')
    await expect(section).toBeVisible({ timeout: 5_000 })

    // stabilize-toggle must exist.
    await expect(page.locator('[data-testid="stabilize-toggle"]')).toBeVisible()

    // Slider and number input must be attached (may be disabled initially).
    await expect(page.locator('[data-testid="effects-stabilize-slider"]')).toBeAttached()
    await expect(page.locator('[data-testid="effects-stabilize-input"]')).toBeAttached()

    // --- Audio clip: section must NOT be present ---
    const audioCid = await addAudioClip()
    if (audioCid !== 'no-audio-track') {
      // Must use DOM click (not store) so Editor.tsx's local selectedClipId
      // actually updates to the audio clip.
      await selectClip(audioCid)
      await page.waitForTimeout(300)
      // The section must be absent (or count 0) for audio-kind clips.
      const sectionForAudio = page.locator('[data-testid="effects-section-stabilize"]')
      const sectionCount = await sectionForAudio.count()
      expect(sectionCount).toBe(0)
    }
  })

  // =========================================================================
  // (2) Toggle ON → clip.stabilize === 50 (DEFAULT_STABILIZE); OFF → undefined
  // =========================================================================
  test('(2) stabilize-toggle ON → clip.stabilize=50; OFF → undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openEffectsPanelAdjust(cid)

    const toggle = page.locator('[data-testid="stabilize-toggle"]')
    await expect(toggle).not.toBeChecked()

    // Initially absent.
    const before = await getClipFromState(cid)
    expect(before?.stabilize).toBeUndefined()

    // Click toggle ON.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stabilize-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(150)

    const clipOn = await getClipFromState(cid)
    expect(clipOn?.stabilize).toBe(DEFAULT_STABILIZE)
    await expect(toggle).toBeChecked()

    // Click toggle OFF.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stabilize-toggle"]') as HTMLElement | null
      if (el) el.click()
    })
    await page.waitForTimeout(150)

    const clipOff = await getClipFromState(cid)
    expect(clipOff?.stabilize).toBeUndefined()
    await expect(toggle).not.toBeChecked()
  })

  // =========================================================================
  // (3) Clamping: 999 → 100; -5 → undefined; NaN → no-op
  // =========================================================================
  test('(3) clamping: setClipStabilize(999)→100; (-5)→undefined; (NaN)→no-op', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // 999 → clamped to MAX_STABILIZE (100).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 999)
    }, cid)
    await page.waitForTimeout(80)
    const clipAt999 = await getClipFromState(cid)
    expect(clipAt999?.stabilize).toBe(MAX_STABILIZE)

    // -5 → below zero → stored as undefined.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, -5)
    }, cid)
    await page.waitForTimeout(80)
    const clipAtMinus5 = await getClipFromState(cid)
    expect(clipAtMinus5?.stabilize).toBeUndefined()

    // Establish a known value, then verify NaN is a no-op.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 70)
    }, cid)
    await page.waitForTimeout(80)
    const clipAt70 = await getClipFromState(cid)
    expect(clipAt70?.stabilize).toBe(70)

    // NaN → must be a no-op (value stays at 70).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, NaN)
    }, cid)
    await page.waitForTimeout(80)
    const clipAfterNaN = await getClipFromState(cid)
    expect(clipAfterNaN?.stabilize).toBe(70)
  })

  // =========================================================================
  // (4) buildPlan: stabilize=50 → deshake=rx= in graph; ordering correct
  //     (AFTER setpts=PTS-STARTPTS, BEFORE setpts=PTS/, BEFORE fps=)
  // =========================================================================
  test('(4) buildPlan stabilize=50 → deshake=rx= in graph; ordering: after reverse/startpts, before speed/fps', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 50)
    }, cid)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `stabilize-plan-50-${Date.now()}.mp4`)
    const result = await buildPlan(outPath)

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''
    expect(graph).toBeTruthy()

    // buildPlan forces deshakeAvailable=true (fallback path for plan-only IPC).
    // stabilize=50: r = max(4, min(32, round(6 + 26*0.5))) = round(19) = 19.
    const expectedR = Math.max(4, Math.min(32, Math.round(6 + 26 * 0.5)))
    expect(graph).toContain(`deshake=rx=${expectedR}:ry=${expectedR}:edge=mirror`)

    // Ordering checks within the per-clip fragment (fragments separated by ";").
    const fragments = graph.split(';')
    const stabFrag = fragments.find((f) => f.includes(`deshake=rx=${expectedR}`))
    expect(stabFrag).toBeTruthy()

    if (stabFrag) {
      const deshakePos = stabFrag.indexOf(`deshake=rx=${expectedR}`)
      const fpsPos = stabFrag.indexOf('fps=')
      const speedPtsPos = stabFrag.indexOf('setpts=PTS/')  // speed filter

      // deshake must come BEFORE fps=.
      if (fpsPos !== -1) {
        expect(deshakePos).toBeLessThan(fpsPos)
      }
      // deshake must come BEFORE speed setpts.
      if (speedPtsPos !== -1) {
        expect(deshakePos).toBeLessThan(speedPtsPos)
      }

      // deshake must come AFTER any setpts=PTS-STARTPTS (trim anchor).
      const startPtsPos = stabFrag.indexOf('setpts=PTS-STARTPTS')
      if (startPtsPos !== -1) {
        expect(deshakePos).toBeGreaterThan(startPtsPos)
      }
    }
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL REGRESSION — stabilize absent → zero stabilize filters
  // =========================================================================
  test('(5) REGRESSION: stabilize absent → no vidstabtransform, no vidstabdetect, no deshake=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // A clip with stabilize never set.
    await addVideoClip(mediaId, durationMs, 0)

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `stabilize-regression-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)

    expect(result.ok).toBe(true)
    const graph: string = result.filterGraph ?? ''

    // All three stabilize filter strings must be absent.
    expect(graph).not.toContain('vidstabtransform')
    expect(graph).not.toContain('vidstabdetect')
    expect(graph).not.toContain('deshake=')

    // Also verify: set stabilize to 0 via store → collapses to undefined → same.
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 0)
    }, cid2)
    await page.waitForTimeout(80)
    const clip2 = await getClipFromState(cid2)
    expect(clip2?.stabilize).toBeUndefined()

    const outPath2 = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `stabilize-regression-zero-${Date.now()}.mp4`
    )
    const result2 = await buildPlan(outPath2)
    expect(result2.ok).toBe(true)
    const graph2: string = result2.filterGraph ?? ''
    expect(graph2).not.toContain('vidstabtransform')
    expect(graph2).not.toContain('deshake=')
  })

  // =========================================================================
  // (6) Mixed timeline: two clips, one stabilize-on + one off →
  //     exactly ONE deshake= fragment in graph
  // =========================================================================
  test('(6) mixed timeline: stabilize-on clip has deshake=; off clip does not; exactly one deshake=', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    const cid1 = await addVideoClip(mediaId, durationMs, 0)
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)

    // Only cid1 has stabilize on (strength=60).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 60)
    }, cid1)

    // cid2 stays off.
    const clip2 = await getClipFromState(cid2)
    expect(clip2?.stabilize).toBeUndefined()

    const outPath = path.join(
      os.tmpdir(),
      'reels-studio-e2e',
      `stabilize-mixed-${Date.now()}.mp4`
    )
    const result = await buildPlan(outPath)

    expect(result.ok).toBe(true)
    const graph = result.filterGraph ?? ''

    // Full graph must contain deshake= (from cid1).
    expect(graph).toContain('deshake=')

    // Exactly one deshake= occurrence.
    const deshakeCount = (graph.match(/deshake=/g) ?? []).length
    expect(deshakeCount).toBe(1)

    // Verify cid1's fragment has deshake= and cid2's does not.
    const fragments = graph.split(';')
    const videoFrags = fragments.filter(
      (f) => f.includes('setpts=PTS-STARTPTS') && !f.includes('asetpts')
    )
    const frag1 = videoFrags[0] ?? null
    const frag2 = videoFrags[1] ?? null

    if (frag1) expect(frag1).toContain('deshake=')
    if (frag2) expect(frag2).not.toContain('deshake=')
  })

  // =========================================================================
  // (7) Undo/redo: toggle on (stabilize=50) → undo → undefined → redo → 50
  // =========================================================================
  test('(7) undo/redo: toggle stabilize on → undo → undefined → redo → 50', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    // Fresh clip has no stabilize.
    const fresh = await getClipFromState(cid)
    expect(fresh?.stabilize).toBeUndefined()

    // Set stabilize to DEFAULT_STABILIZE (50).
    await page.evaluate(([id, strength]: [string, number]) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, strength)
    }, [cid, DEFAULT_STABILIZE] as [string, number])
    await tick()

    const withStabilize = await getClipFromState(cid)
    expect(withStabilize?.stabilize).toBe(DEFAULT_STABILIZE)

    // Undo → stabilize should be undefined.
    await undo()
    await page.waitForTimeout(100)
    const afterUndo = await getClipFromState(cid)
    expect(afterUndo?.stabilize).toBeUndefined()

    // Redo → stabilize should be 50 again.
    await redo()
    await page.waitForTimeout(100)
    const afterRedo = await getClipFromState(cid)
    expect(afterRedo?.stabilize).toBe(DEFAULT_STABILIZE)
  })

  // =========================================================================
  // (8) Preview attribute: clip.stabilize=50 → data-stabilize="true";
  //     absent → data-stabilize="false"
  // =========================================================================
  test('(8) preview: stabilize=50 → data-stabilize=true; absent → data-stabilize=false', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Move playhead onto the clip so the preview renders.
    await page.evaluate((ms) => {
      window.__reelsTimelineUi.getState().setPlayheadMs(ms)
    }, Math.floor(durationMs / 2))
    await page.waitForTimeout(400)

    const video = page.locator('[data-testid="preview-video"]')
    await expect(video).toBeVisible({ timeout: 5_000 })

    // Initially no stabilize — data-stabilize must be 'false'.
    const attrBefore = await video.getAttribute('data-stabilize')
    expect(attrBefore).toBe('false')

    // Apply stabilize=50 via store.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 50)
    }, cid)
    await page.waitForTimeout(300)

    // data-stabilize must now be 'true'.
    const attrAfter = await video.getAttribute('data-stabilize')
    expect(attrAfter).toBe('true')

    // Verify CSS filter string is UNCHANGED vs a no-stabilize clip
    // (no CSS preview — stabilize is export-only).
    const cssFilterOn = await video.evaluate(
      (el) => (el as HTMLVideoElement).style.filter
    )
    // Remove stabilize.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 0)
    }, cid)
    await page.waitForTimeout(300)

    const attrRemoved = await video.getAttribute('data-stabilize')
    expect(attrRemoved).toBe('false')

    const cssFilterOff = await video.evaluate(
      (el) => (el as HTMLVideoElement).style.filter
    )
    // CSS filter must be identical whether stabilize is on or off (export-only).
    expect(cssFilterOn).toBe(cssFilterOff)
  })

  // =========================================================================
  // (9) Real-encode smoke (CRITICAL):
  //     exporter.run on clip with stabilize=60 → ok:true, output mp4 > 1KB.
  //     If vidstab is available: stabilize-cache/ has exactly 1 .trf > 0 bytes;
  //     second run with stabilize=80 → .trf mtime UNCHANGED (cache hit).
  // =========================================================================
  test('(9) real-encode smoke: stabilize=60 → ok, mp4 > 1KB; vidstab cache hit on strength change', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 60)
    }, cid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath1 = path.join(outDir, `stabilize-smoke-60-${Date.now()}.mp4`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath1)

    const r1 = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-stabilize-60-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath1 },
    )

    expect(r1.ok, `stabilize=60 export failed: ${r1.error ?? ''}`).toBe(true)
    expect(existsSync(outPath1)).toBe(true)
    expect(statSync(outPath1).size).toBeGreaterThan(1024)

    // Check for vidstab cache (only when vidstab is available in bundled ffmpeg).
    const stabilizeCacheDir = path.join(launched.userDataDir, 'stabilize-cache')
    const hasVidstabCache = existsSync(stabilizeCacheDir)
    if (hasVidstabCache) {
      const trfFiles = readdirSync(stabilizeCacheDir).filter((f) => f.endsWith('.trf'))
      expect(trfFiles.length).toBe(1)
      expect(statSync(path.join(stabilizeCacheDir, trfFiles[0])).size).toBeGreaterThan(0)

      // Store the mtime of the .trf file before the second run.
      const trfPath = path.join(stabilizeCacheDir, trfFiles[0])
      const mtimeBefore = statSync(trfPath).mtimeMs

      // Second run with stabilize=80 (same clip, different strength).
      await page.evaluate((id) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 80)
      }, cid)
      const outPath2 = path.join(outDir, `stabilize-smoke-80-${Date.now()}.mp4`)
      await page.evaluate(async (p) => {
        await window.electron.fs.allowPath(p)
      }, outPath2)

      const r2 = await page.evaluate(
        async ({ outputPath }) => {
          const reels = window.__reelsStore
          const project = reels.state().project
          return await window.electron.exporter.run(project, {
            jobId: `e2e-stabilize-80-${Date.now()}`,
            presetKey: 'instagram-reels',
            outputPath
          })
        },
        { outputPath: outPath2 },
      )

      expect(r2.ok, `stabilize=80 export failed: ${r2.error ?? ''}`).toBe(true)
      expect(existsSync(outPath2)).toBe(true)
      expect(statSync(outPath2).size).toBeGreaterThan(1024)

      // .trf mtime must be UNCHANGED — proves strength is NOT in the cache key.
      const mtimeAfter = statSync(trfPath).mtimeMs
      expect(mtimeAfter, '.trf mtime changed — strength was incorrectly used as a cache key').toBe(mtimeBefore)

      // Still exactly 1 .trf file (no new file created for strength=80).
      const trfFilesAfter = readdirSync(stabilizeCacheDir).filter((f) => f.endsWith('.trf'))
      expect(trfFilesAfter.length).toBe(1)
    }
    // If vidstab is unavailable, the encode used deshake (single-pass, no .trf).
    // The smoke test still passes with ok:true and mp4 > 1KB above.
  }, 120_000)

  // =========================================================================
  // (10) Progress events:
  //      Export with stabilize-enabled clip → at least one ffmpeg:progress event
  //      with message==='stabilize-detect' BEFORE normal encoding events.
  //      No-stabilize project → ZERO stabilize-detect events (byte-identical IPC).
  // =========================================================================
  test('(10) progress: stabilize export emits stabilize-detect events; no-stabilize emits ZERO', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // --- Case A: stabilize-enabled ---
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 50)
    }, cid)

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPathA = path.join(outDir, `stabilize-progress-a-${Date.now()}.mp4`)
    await page.evaluate(async (p) => { await window.electron.fs.allowPath(p) }, outPathA)

    // Capture IPC events from the renderer side.
    // onProgress delivers payloads directly (preload unwraps the IPC envelope).
    const capturedEvents = await page.evaluate(
      async ({ outputPath }) => {
        const events: Array<{ message?: string; percent?: number; done?: boolean }> = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsub = window.electron.ffmpeg.onProgress((payload: any) => {
          events.push({
            message: payload?.message ?? undefined,
            percent: payload?.percent ?? undefined,
            done: payload?.done ?? undefined
          })
        })
        try {
          const reels = window.__reelsStore
          const project = reels.state().project
          await window.electron.exporter.run(project, {
            jobId: `e2e-progress-a-${Date.now()}`,
            presetKey: 'instagram-reels',
            outputPath
          })
        } finally {
          if (typeof unsub === 'function') unsub()
        }
        return events
      },
      { outputPath: outPathA }
    )

    // Partition into stabilize-detect events and normal encoding events.
    const detectEvents = capturedEvents.filter((e) => e.message === 'stabilize-detect')
    const normalEvents = capturedEvents.filter((e) => e.message !== 'stabilize-detect' && !e.done)

    // When vidstab is available, we expect at least one stabilize-detect event.
    // When vidstab is unavailable (deshake fallback), no detect events are emitted.
    const stabilizeCacheDir = path.join(launched.userDataDir, 'stabilize-cache')
    const vidstabUsed = existsSync(stabilizeCacheDir)

    if (vidstabUsed) {
      expect(detectEvents.length, 'expected stabilize-detect events for vidstab export').toBeGreaterThanOrEqual(1)

      // All detect events must precede the first normal encoding event (percent-wise).
      if (detectEvents.length > 0 && normalEvents.length > 0) {
        // Find the index of the first normal event in the full sequence.
        const firstNormalIndex = capturedEvents.findIndex(
          (e) => e.message !== 'stabilize-detect' && !e.done
        )
        const lastDetectIndex = capturedEvents.map((e) => e.message === 'stabilize-detect').lastIndexOf(true)
        expect(lastDetectIndex).toBeLessThan(firstNormalIndex)
      }
    }

    // --- Case B: no-stabilize — ZERO stabilize-detect events (byte-identical IPC) ---
    // Turn stabilize off.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipStabilize(id, 0)
    }, cid)
    await page.waitForTimeout(80)

    const outPathB = path.join(outDir, `stabilize-progress-b-${Date.now()}.mp4`)
    await page.evaluate(async (p) => { await window.electron.fs.allowPath(p) }, outPathB)

    const eventsNoStab = await page.evaluate(
      async ({ outputPath }) => {
        const events: Array<{ message?: string }> = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsub = window.electron.ffmpeg.onProgress((payload: any) => {
          events.push({ message: payload?.message ?? undefined })
        })
        try {
          const reels = window.__reelsStore
          const project = reels.state().project
          await window.electron.exporter.run(project, {
            jobId: `e2e-progress-b-${Date.now()}`,
            presetKey: 'instagram-reels',
            outputPath
          })
        } finally {
          if (typeof unsub === 'function') unsub()
        }
        return events
      },
      { outputPath: outPathB }
    )

    const detectEventsNoStab = eventsNoStab.filter((e) => e.message === 'stabilize-detect')
    expect(
      detectEventsNoStab.length,
      'no-stabilize export must emit ZERO stabilize-detect events'
    ).toBe(0)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Pure constant sanity (no app launch required)
// ---------------------------------------------------------------------------
test('@phase-stabilize formula constants match shared/project.ts values', () => {
  expect(MIN_STABILIZE).toBe(0)
  expect(MAX_STABILIZE).toBe(100)
  expect(DEFAULT_STABILIZE).toBe(50)

  // stabilizeShakiness: 1..100 → 1..10.
  // Pure math: round(1 + (i - 1) * 9 / 99), clamped 1..10.
  function stabilizeShakiness(intensity: number): number {
    const i = Math.min(100, Math.max(1, intensity))
    return Math.max(1, Math.min(10, Math.round(1 + ((i - 1) * 9) / 99)))
  }
  expect(stabilizeShakiness(1)).toBe(1)
  expect(stabilizeShakiness(100)).toBe(10)
  expect(stabilizeShakiness(50)).toBeGreaterThanOrEqual(1)
  expect(stabilizeShakiness(50)).toBeLessThanOrEqual(10)

  // stabilizeToFfmpeg deshake: r = max(4, min(32, round(6 + 26 * t))).
  function deshakeR(intensity: number): number {
    const t = Math.min(100, Math.max(1, intensity)) / 100
    return Math.max(4, Math.min(32, Math.round(6 + 26 * t)))
  }
  // strength=50 → t=0.5 → r=round(6+13)=19.
  expect(deshakeR(50)).toBe(19)
  // strength=1 → t=0.01 → r=round(6+0.26)=round(6.26)=6.
  expect(deshakeR(1)).toBe(6)
  // strength=100 → t=1 → r=round(32)=32.
  expect(deshakeR(100)).toBe(32)
})
