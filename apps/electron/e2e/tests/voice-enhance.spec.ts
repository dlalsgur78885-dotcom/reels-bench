/**
 * @phase-voice-enhance — per-clip 음성 보정 (voice enhancement) toggle + export filter.
 *
 * Covers all 12 contracted scenarios from the TEST brief:
 *
 * UI:
 *   (1)  menu-voice-enhance visible for media clips; NOT present for caption clips.
 *        Header chip reads "꺼짐" when voiceEnhance absent.
 *   (2)  Master toggle ON → clip.voiceEnhance = DEFAULT_VOICE_ENHANCE, header "켜짐 (1)".
 *        Toggle OFF → clip.voiceEnhance undefined, header "꺼짐".
 *   (3)  Sub-checkbox independence — each of 5 fields independently reflects in store.
 *        All-OFF → collapse to undefined.
 *   (4)  Hint text "내보내기 시 적용" visible in menu-voice-enhance-panel.
 *
 * Export graph — byte-identical regression:
 *   (5)  REGRESSION: clip with NO voiceEnhance → filter graph contains NONE of:
 *        loudnorm, acompressor, deesser, highpass=f=80, equalizer=f=3000, firequalizer.
 *   (6)  Single-toggle emissions — 5 solo scenarios, each asserts only its own filter.
 *   (7)  Full chain ORDER — all 5 ON → order is highpass < equalizer < deesser < acompressor < loudnorm.
 *   (8)  VE + denoise stacking — afftdn appears BEFORE loudnorm.
 *
 * Undo/redo:
 *   (9)  Master ON → undo → undefined → redo → DEFAULT_VOICE_ENHANCE.
 *
 * Capability fallback:
 *   (10) deEsserAvailable probe: deEss ON with real bundled ffmpeg → deesser= present;
 *        verifies the firequalizer fallback path is documented as not directly reachable
 *        without a test-only override.
 *
 * Real-encode smoke (CRITICAL):
 *   (11) All 5 sub-toggles ON, exporter.run → ok=true, output mp4 > 1 KB.
 *
 * Mixed timeline:
 *   (12) Two clips: one VE-on (loudnorm) + one VE-off → exactly one loudnorm= token.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type declarations for window test bridges
// ---------------------------------------------------------------------------
type VoiceEnhance = {
  loudnorm: boolean
  compress: boolean
  deEss: boolean
  eqLowCut: boolean
  eqPresence: boolean
}

type ProjectStoreState = {
  project: {
    tracks: Array<{
      id: string
      kind: string
      role?: string
      clips: Array<Record<string, unknown>>
    }>
    media: Record<string, unknown>
  }
  setClipVoiceEnhance: (clipId: string, patch: Partial<VoiceEnhance>) => void
  setClipNoiseReduction: (clipId: string, strength: number) => void
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
      setClipVoiceEnhance: (id: string, patch: Partial<VoiceEnhance>) => void
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
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-voice-enhance voice enhancement toggle + export filter', () => {
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
  // Internal helpers (mirror noise-reduction.spec.ts patterns exactly)
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
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __reelsUndoRedo?: unknown }).__reelsUndoRedo,
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

  /** Set voiceEnhance on a clip via the store directly. */
  async function setVoiceEnhance(
    clipId: string,
    patch: Partial<VoiceEnhance>
  ): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(
      ({ id, p }) => {
        window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceEnhance(id, p)
      },
      { id: clipId, p: patch }
    )
    await launched.page.waitForTimeout(80)
  }

  /** Right-click the timeline clip block to open context menu. */
  async function openContextMenu(clipId: string): Promise<void> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    const clipBlock = page.locator(`[data-testid="media-clip-block"][data-clip-id="${clipId}"]`)
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({ timeout: 3_000 })
  }

  /** Open context menu and expand the voice-enhance panel. */
  async function openVoiceEnhancePanel(clipId: string): Promise<void> {
    await openContextMenu(clipId)
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await expect(page.locator('[data-testid="menu-voice-enhance"]')).toBeVisible({ timeout: 3_000 })
    // Programmatic click handles viewport overflow (mirrors blur-region + noise-reduction pattern).
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="menu-voice-enhance"]') as HTMLElement | null
      if (el) el.click()
    })
    await expect(page.locator('[data-testid="menu-voice-enhance-panel"]')).toBeAttached({
      timeout: 3_000
    })
  }

  /** Build the export plan and return the full filterGraph string. */
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

  /** Sleep >= undo throttle window. */
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
  // (1) UI presence — menu-voice-enhance visible for media clips; absent for captions
  // =========================================================================
  test('(1) menu-voice-enhance visible for media clip; NOT present for caption; header reads "꺼짐"', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Media clip: right-click → menu-voice-enhance visible.
    await openContextMenu(cid)
    await expect(page.locator('[data-testid="menu-voice-enhance"]')).toBeVisible()

    // Header chip must read "꺼짐" when voiceEnhance is absent.
    const headerText = await page.locator('[data-testid="menu-voice-enhance"]').textContent()
    expect(headerText).toContain('꺼짐')

    // Panel is NOT rendered until user expands it.
    await expect(page.locator('[data-testid="menu-voice-enhance-panel"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveCount(0)

    // Caption clip: menu-voice-enhance must NOT be present.
    await page.locator('[data-testid="add-caption-button"]').click()
    await expect(page.locator('[data-testid="caption-editor"]')).toBeVisible()
    await page.locator('[data-testid="caption-editor-close"]').click()
    const captionBlock = page.locator('[data-testid="caption-clip-block"]').first()
    await captionBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('[data-testid="menu-voice-enhance"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (2) Master toggle ON → DEFAULT_VOICE_ENHANCE + chip "켜짐 (1)"; OFF → undefined
  // =========================================================================
  test('(2) master toggle ON → DEFAULT_VOICE_ENHANCE, header "켜짐 (1)"; OFF → undefined, "꺼짐"', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openVoiceEnhancePanel(cid)

    // Initially master toggle is unchecked.
    const masterToggle = page.locator('[data-testid="voice-enhance-toggle"]')
    await expect(masterToggle).not.toBeChecked()

    // Click master toggle ON (programmatic to handle viewport overflow).
    await page.evaluate(() => {
      const chk = document.querySelector('[data-testid="voice-enhance-toggle"]') as HTMLElement | null
      if (chk) chk.click()
    })
    await page.waitForTimeout(120)

    // Store must have DEFAULT_VOICE_ENHANCE: loudnorm=true, others=false.
    const clipOn = await getClipFromState(cid)
    const ve = clipOn?.voiceEnhance as VoiceEnhance | undefined
    expect(ve).toBeTruthy()
    expect(ve?.loudnorm).toBe(true)
    expect(ve?.compress).toBe(false)
    expect(ve?.deEss).toBe(false)
    expect(ve?.eqLowCut).toBe(false)
    expect(ve?.eqPresence).toBe(false)

    // Header must show "켜짐 (1)" (1 sub-toggle active = loudnorm).
    await expect(page.locator('[data-testid="menu-voice-enhance"]')).toContainText('켜짐 (1)', {
      timeout: 3_000
    })

    // Click master toggle again to turn OFF.
    await page.evaluate(() => {
      const chk = document.querySelector('[data-testid="voice-enhance-toggle"]') as HTMLElement | null
      if (chk) chk.click()
    })
    await page.waitForTimeout(120)

    const clipOff = await getClipFromState(cid)
    // Store collapses all-false to undefined.
    expect(clipOff?.voiceEnhance).toBeUndefined()
    await expect(page.locator('[data-testid="menu-voice-enhance"]')).toContainText('꺼짐', {
      timeout: 3_000
    })

    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (3) Sub-checkbox independence — each field independently reflects in store
  // =========================================================================
  test('(3) sub-checkboxes are independent; all-OFF collapses voiceEnhance to undefined', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // First enable master so sub-checkboxes become active.
    await setVoiceEnhance(cid, { loudnorm: true })

    // Verify each sub-checkbox individually via the store action.
    // loudnorm
    await setVoiceEnhance(cid, { loudnorm: true, compress: false, deEss: false, eqLowCut: false, eqPresence: false })
    let clip = await getClipFromState(cid)
    expect((clip?.voiceEnhance as VoiceEnhance)?.loudnorm).toBe(true)
    expect((clip?.voiceEnhance as VoiceEnhance)?.compress).toBe(false)

    // compress
    await setVoiceEnhance(cid, { loudnorm: false, compress: true, deEss: false, eqLowCut: false, eqPresence: false })
    clip = await getClipFromState(cid)
    expect((clip?.voiceEnhance as VoiceEnhance)?.loudnorm).toBe(false)
    expect((clip?.voiceEnhance as VoiceEnhance)?.compress).toBe(true)

    // deEss
    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: true, eqLowCut: false, eqPresence: false })
    clip = await getClipFromState(cid)
    expect((clip?.voiceEnhance as VoiceEnhance)?.deEss).toBe(true)
    expect((clip?.voiceEnhance as VoiceEnhance)?.loudnorm).toBe(false)

    // eqLowCut
    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: false, eqLowCut: true, eqPresence: false })
    clip = await getClipFromState(cid)
    expect((clip?.voiceEnhance as VoiceEnhance)?.eqLowCut).toBe(true)

    // eqPresence
    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: false, eqLowCut: false, eqPresence: true })
    clip = await getClipFromState(cid)
    expect((clip?.voiceEnhance as VoiceEnhance)?.eqPresence).toBe(true)

    // All OFF → collapse to undefined.
    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: false, eqLowCut: false, eqPresence: false })
    clip = await getClipFromState(cid)
    expect(clip?.voiceEnhance).toBeUndefined()

    // UI sub-checkboxes disabled when master is off — open panel and verify.
    await openVoiceEnhancePanel(cid)
    await expect(page.locator('[data-testid="vc-loudnorm"]')).toBeDisabled()
    await expect(page.locator('[data-testid="vc-compress"]')).toBeDisabled()
    await expect(page.locator('[data-testid="vc-deess"]')).toBeDisabled()
    await expect(page.locator('[data-testid="vc-eqlowcut"]')).toBeDisabled()
    await expect(page.locator('[data-testid="vc-eqpresence"]')).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (4) Hint text "내보내기 시 적용" visible in panel
  // =========================================================================
  test('(4) hint "내보내기 시 적용" visible inside menu-voice-enhance-panel', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await openVoiceEnhancePanel(cid)

    const panel = page.locator('[data-testid="menu-voice-enhance-panel"]')
    await expect(panel).toContainText('내보내기 시 적용')

    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (5) BYTE-IDENTICAL REGRESSION — clip with NO voiceEnhance → none of the
  //     VE filter tokens appear in the graph.
  // =========================================================================
  test('(5) REGRESSION: clip with no voiceEnhance → NO VE filters in audio graph', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    // Deliberately leave voiceEnhance absent.
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-baseline-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)

    expect(ok).toBe(true)
    expect(graph.length).toBeGreaterThan(0)

    // None of the VE filter tokens must appear.
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('acompressor')
    expect(graph).not.toContain('deesser')
    expect(graph).not.toContain('highpass=f=80')
    expect(graph).not.toContain('equalizer=f=3000')
    expect(graph).not.toContain('firequalizer')
  })

  // =========================================================================
  // (6) Single-toggle emissions — 5 solo scenarios
  // =========================================================================
  test('(6a) solo loudnorm → only loudnorm= present; no other VE tokens', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: true, compress: false, deEss: false, eqLowCut: false, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-solo-loudnorm-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)
    expect(graph).toContain('loudnorm=I=-16:TP=-1.5:LRA=11')
    expect(graph).not.toContain('acompressor')
    expect(graph).not.toContain('deesser')
    expect(graph).not.toContain('highpass=f=80')
    expect(graph).not.toContain('equalizer=f=3000')
  })

  test('(6b) solo compress → only acompressor= present; no loudnorm or deesser', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: false, compress: true, deEss: false, eqLowCut: false, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-solo-compress-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)
    expect(graph).toContain('acompressor=threshold=-18dB:ratio=4:attack=5:release=80:makeup=2')
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('deesser')
    expect(graph).not.toContain('highpass=f=80')
    expect(graph).not.toContain('equalizer=f=3000')
  })

  test('(6c) solo deEss → only deesser= OR firequalizer= present; no loudnorm or acompressor', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: true, eqLowCut: false, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-solo-deess-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)
    // Either deesser (preferred) or firequalizer (capability fallback) must be present.
    const hasDeEss = graph.includes('deesser=') || graph.includes('firequalizer=')
    expect(hasDeEss).toBe(true)
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('acompressor')
    expect(graph).not.toContain('highpass=f=80')
    expect(graph).not.toContain('equalizer=f=3000')
  })

  test('(6d) solo eqLowCut → only highpass=f=80 present; no other VE tokens', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: false, eqLowCut: true, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-solo-lowcut-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)
    expect(graph).toContain('highpass=f=80')
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('acompressor')
    expect(graph).not.toContain('deesser')
    expect(graph).not.toContain('firequalizer')
    expect(graph).not.toContain('equalizer=f=3000')
  })

  test('(6e) solo eqPresence → only equalizer=f=3000 present; no other VE tokens', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: false, eqLowCut: false, eqPresence: true })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-solo-presence-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)
    expect(graph).toContain('equalizer=f=3000:t=h:width=2:g=2')
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('acompressor')
    expect(graph).not.toContain('deesser')
    expect(graph).not.toContain('firequalizer')
    expect(graph).not.toContain('highpass=f=80')
  })

  // =========================================================================
  // (7) Full chain ORDER — all 5 ON → fixed ordering in audio fragment
  // =========================================================================
  test('(7) all 5 ON → chain order: highpass < equalizer < de-ess < acompressor < loudnorm', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, {
      loudnorm: true,
      compress: true,
      deEss: true,
      eqLowCut: true,
      eqPresence: true
    })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-order-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    // Locate the audio fragment that contains all VE filters.
    const fragments = graph.split(';')
    const veFragment = fragments.find(
      (f) =>
        f.includes('highpass=f=80') &&
        f.includes('equalizer=f=3000') &&
        f.includes('acompressor=') &&
        f.includes('loudnorm=')
    )
    expect(veFragment).toBeTruthy()

    const highpassPos = veFragment!.indexOf('highpass=f=80')
    const equalizerPos = veFragment!.indexOf('equalizer=f=3000')
    // deesser= or firequalizer= depending on capability
    const deEssPos = Math.max(veFragment!.indexOf('deesser='), veFragment!.indexOf('firequalizer='))
    const compressorPos = veFragment!.indexOf('acompressor=')
    const loudnormPos = veFragment!.indexOf('loudnorm=I=-16')

    expect(highpassPos).toBeGreaterThan(-1)
    expect(equalizerPos).toBeGreaterThan(-1)
    expect(deEssPos).toBeGreaterThan(-1)
    expect(compressorPos).toBeGreaterThan(-1)
    expect(loudnormPos).toBeGreaterThan(-1)

    // Strict ordering.
    expect(highpassPos).toBeLessThan(equalizerPos)
    expect(equalizerPos).toBeLessThan(deEssPos)
    expect(deEssPos).toBeLessThan(compressorPos)
    expect(compressorPos).toBeLessThan(loudnormPos)
  })

  // =========================================================================
  // (8) VE + denoise stacking — afftdn BEFORE loudnorm
  // =========================================================================
  test('(8) VE + denoise stacking: afftdn appears BEFORE loudnorm in audio fragment', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    // Enable noiseReduction=50 AND voiceEnhance.loudnorm.
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipNoiseReduction(id, 50)
    }, cid)
    await setVoiceEnhance(cid, { loudnorm: true, compress: false, deEss: false, eqLowCut: false, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-denoise-stack-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    // Both must be present (afftdn only when the bundled ffmpeg supports it;
    // if afftdn is absent, skip the ordering check — that's the capability gate).
    if (graph.includes('afftdn')) {
      expect(graph).toContain('loudnorm=I=-16')
      const afftdnPos = graph.indexOf('afftdn')
      const loudnormPos = graph.indexOf('loudnorm=I=-16')
      expect(afftdnPos).toBeLessThan(loudnormPos)
    } else {
      // Bundled ffmpeg lacks afftdn — just verify loudnorm is still present.
      expect(graph).toContain('loudnorm=I=-16')
    }
  })

  // =========================================================================
  // (9) Undo/redo — master toggle ON → undo → undefined → redo → DEFAULT_VOICE_ENHANCE
  // =========================================================================
  test('(9) undo/redo: toggle ON → undo → undefined → redo → DEFAULT_VOICE_ENHANCE', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick()
    const cid = await addVideoClip(mediaId, durationMs)
    await tick()

    // Fresh clip has no voiceEnhance.
    const fresh = await getClipFromState(cid)
    expect(fresh?.voiceEnhance).toBeUndefined()

    // Set DEFAULT_VOICE_ENHANCE via store (loudnorm-only).
    await page.evaluate((id) => {
      window.__PROJECT_STORE_FOR_TEST__.getState().setClipVoiceEnhance(id, {
        loudnorm: true,
        compress: false,
        deEss: false,
        eqLowCut: false,
        eqPresence: false
      })
    }, cid)
    await tick()

    const withVe = await getClipFromState(cid)
    expect((withVe?.voiceEnhance as VoiceEnhance | undefined)?.loudnorm).toBe(true)

    // Undo → voiceEnhance should be undefined.
    await undo()
    await page.waitForTimeout(100)
    const afterUndo = await getClipFromState(cid)
    expect(afterUndo?.voiceEnhance).toBeUndefined()

    // Redo → DEFAULT_VOICE_ENHANCE restored.
    await redo()
    await page.waitForTimeout(100)
    const afterRedo = await getClipFromState(cid)
    expect((afterRedo?.voiceEnhance as VoiceEnhance | undefined)?.loudnorm).toBe(true)
    expect((afterRedo?.voiceEnhance as VoiceEnhance | undefined)?.compress).toBe(false)
    expect((afterRedo?.voiceEnhance as VoiceEnhance | undefined)?.deEss).toBe(false)
    expect((afterRedo?.voiceEnhance as VoiceEnhance | undefined)?.eqLowCut).toBe(false)
    expect((afterRedo?.voiceEnhance as VoiceEnhance | undefined)?.eqPresence).toBe(false)
  })

  // =========================================================================
  // (10) Capability fallback — verify bundled ffmpeg produces deesser= (or documents
  //      the fallback). The firequalizer path is not directly testable without a
  //      probe-override hook; we verify the real path here.
  // =========================================================================
  test('(10) capability: deEss ON with real bundled ffmpeg → deesser= OR firequalizer= in graph', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, { loudnorm: false, compress: false, deEss: true, eqLowCut: false, eqPresence: false })

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-cap-deess-${Date.now()}.mp4`)
    const { ok, graph } = await buildPlanGraph(outPath)
    expect(ok).toBe(true)

    // The bundled ffmpeg either supports deesser= (preferred) or falls back to
    // firequalizer= (when deEsserAvailable=false from the probe). Either is correct.
    const hasDeEss = graph.includes('deesser=') || graph.includes('firequalizer=gain_entry=')
    expect(hasDeEss).toBe(true)

    // Document: the firequalizer fallback is verified in voiceEnhanceToFfmpeg
    // unit contract (filterPresets.ts). Direct e2e testing of the fallback path
    // requires deEsserAvailable=false override, which is not exposed as a renderer
    // IPC — it is exercised by the __test export in export.ts unit tests.
    // Here we confirm real-bundled-ffmpeg behaviour: whichever path is chosen,
    // the filter appears exactly once.
    const deesserCount = (graph.match(/deesser=/g) ?? []).length
    const firequalizerCount = (graph.match(/firequalizer=/g) ?? []).length
    expect(deesserCount + firequalizerCount).toBe(1)
  })

  // =========================================================================
  // (11) Real-encode smoke (CRITICAL) — all 5 toggles ON, exporter.run → ok:true
  // =========================================================================
  test('(11) SMOKE: all 5 toggles ON + exporter.run → ok:true, mp4 > 1 KB', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const cid = await addVideoClip(mediaId, durationMs)

    await setVoiceEnhance(cid, {
      loudnorm: true,
      compress: true,
      deEss: true,
      eqLowCut: true,
      eqPresence: true
    })

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `ve-smoke-${Date.now()}.mp4`)

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const reels = window.__reelsStore
        const project = reels.state().project
        return await window.electron.exporter.run(project, {
          jobId: `ve-smoke-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath },
      // Allow up to 60 s for a real encode.
    )

    expect(r.ok, `expected smoke export ok, error: ${r.error ?? ''}`).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  }, 90_000)

  // =========================================================================
  // (12) Mixed timeline — VE-on clip + VE-off clip → exactly one loudnorm= token
  // =========================================================================
  test('(12) mixed timeline: VE-on clip has loudnorm; VE-off clip does not; exactly 1 token', async () => {
    if (!launched) throw new Error('launch failed')
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    const cid1 = await addVideoClip(mediaId, durationMs, 0)
    const cid2 = await addVideoClip(mediaId, durationMs, durationMs)

    // Only cid1 gets loudnorm.
    await setVoiceEnhance(cid1, { loudnorm: true, compress: false, deEss: false, eqLowCut: false, eqPresence: false })

    // cid2 stays off.
    const clip2 = await getClipFromState(cid2)
    expect(clip2?.voiceEnhance).toBeUndefined()

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `ve-mixed-${Date.now()}.mp4`)
    const result = await (launched!.page.evaluate(
      async ({ outputPath, id1, id2 }) => {
        const project = window.__reelsStore.state().project
        const plan = await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
        const graph = plan.filterGraph ?? ''
        const fragments = graph.split(';')
        const suffix1 = id1.slice(-6)
        const suffix2 = id2.slice(-6)
        // Find the audio fragment for each clip (contains atrim and labeled with clip suffix).
        const frag1 =
          fragments.find(
            (f) => (f.includes(`av${suffix1}`) || f.includes(`at${suffix1}`)) && f.includes('atrim')
          ) ?? null
        const frag2 =
          fragments.find(
            (f) => (f.includes(`av${suffix2}`) || f.includes(`at${suffix2}`)) && f.includes('atrim')
          ) ?? null
        return {
          ok: plan.ok as boolean,
          fullGraph: graph,
          frag1,
          frag2
        }
      },
      { outputPath: outPath, id1: cid1, id2: cid2 }
    ))

    expect(result.ok).toBe(true)

    // Exactly one loudnorm= token in the entire graph.
    const loudnormCount = (result.fullGraph.match(/loudnorm=/g) ?? []).length
    expect(loudnormCount).toBe(1)

    // cid1's fragment must contain loudnorm.
    if (result.frag1) {
      expect(result.frag1).toContain('loudnorm=')
    }

    // cid2's fragment must NOT contain loudnorm.
    if (result.frag2) {
      expect(result.frag2).not.toContain('loudnorm=')
    }
  })
})
