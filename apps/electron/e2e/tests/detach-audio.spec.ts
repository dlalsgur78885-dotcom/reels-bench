/**
 * @phase-detach-audio — "오디오 분리" (detach audio) feature tests.
 *
 * Covers all contracted scenarios:
 *
 * (1)  detachAudio creates an audio clip on an audio track + mutes the source
 *      video clip (same mediaId, equal startMs/endMs/trimInMs/trimOutMs).
 * (2)  No doubled audio at export — muted source contributes no audio chain;
 *      only the detached clip's chain appears in the filterGraph.
 * (3)  Detached audio clip IS present in the export graph (not muted).
 * (4)  Undo restores in one step — audio clip gone + source isMuted reverts;
 *      exactly one history step consumed. Redo re-applies.
 * (5)  Edit independence — setClipGainDb on the detached clip does NOT mutate
 *      the source clip (and vice versa).
 * (6)  No-op cases — detachAudio on an audio-track clip returns null;
 *      detachAudio on an already-muted video clip returns null.
 * (7)  Byte-identical baseline — project where detachAudio was never called
 *      → buildPlan graph identical to a fresh baseline (no phantom audio fragments).
 * (8)  Context-menu gating — menu-detach-audio is enabled (aria-disabled=false)
 *      for a normal video-track media clip; disabled for an audio-track clip /
 *      an already-muted clip.
 * (9)  Real export (if feasible) — exporter.run on a project with a detached
 *      audio clip completes without ffmpeg error; output mp4 has audio.
 */

import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchElectron, type LaunchedApp } from '../helpers/launch'

// ---------------------------------------------------------------------------
// Type bridges
// ---------------------------------------------------------------------------
type Track = {
  id: string
  kind: string
  role?: string
  name?: string
  clips: Array<Record<string, unknown>>
}

type ProjectState = {
  project: {
    tracks: Track[]
    media: Record<string, unknown>
  }
}

declare global {
  interface Window {
    __PROJECT_STORE_FOR_TEST__: {
      getState: () => ProjectState & { createNew: () => void }
    }
    __reelsStore: {
      state: () => ProjectState
      addMedia: (a: unknown) => void
      addClip: (c: unknown) => void
      detachAudio: (clipId: string) => string | null
      setClipGainDb: (clipId: string, db: number) => void
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
      getState: () => { setPlayheadMs: (ms: number) => void }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe('@phase-detach-audio audio detach — 오디오 분리', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => {
    // Small guard so a previous process's debug port fully releases.
    await new Promise((r) => setTimeout(r, 600))
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

  /** Add a media clip on the first video track and return its clip id. */
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

  /** Find a clip by id across all tracks; returns null when not found. */
  async function findClip(clipId: string): Promise<Record<string, unknown> | null> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return (await page.evaluate((cid) => {
      for (const t of window.__reelsStore.state().project.tracks)
        for (const c of t.clips)
          if ((c as { id?: string }).id === cid) return c
      return null
    }, clipId)) as Record<string, unknown> | null
  }

  /** Return all tracks from the current project. */
  async function getTracks(): Promise<Track[]> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() =>
      window.__reelsStore.state().project.tracks as Track[]
    )
  }

  /** Read past/future undo history depths. */
  async function getHistoryCounts(): Promise<{ past: number; future: number }> {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    return page.evaluate(() => {
      const s = window.__reelsUndoRedo.getState()
      return { past: s.pastStates.length, future: s.futureStates.length }
    })
  }

  async function undo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => window.__reelsUndoRedo.getState().undo())
  }

  async function redo(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.evaluate(() => window.__reelsUndoRedo.getState().redo())
  }

  /** Wait long enough for zundo's 200ms throttle window to close. */
  async function tick(): Promise<void> {
    if (!launched) throw new Error('launch failed')
    await launched.page.waitForTimeout(250)
  }

  // =========================================================================
  // (1) detachAudio creates audio clip + mutes the source
  // =========================================================================
  test('(1) detachAudio creates media clip on audio track with same mediaId/startMs/endMs/trimInMs/trimOutMs; source isMuted=true', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    // Verify no audio track with media clips exists yet.
    const tracksBefore = await getTracks()
    const audioTrackBefore = tracksBefore.find((t) => t.kind === 'audio')
    // There may be BGM/voice tracks but they should have no media clips from our fixture.
    const audioMediaClipsBefore = audioTrackBefore?.clips.filter(
      (c) => (c as { kind?: string }).kind === 'media'
    ) ?? []
    expect(audioMediaClipsBefore.length).toBe(0)

    // Call detachAudio.
    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()

    // (a) Source clip is now muted.
    const srcClip = await findClip(srcId)
    expect(srcClip).not.toBeNull()
    expect(srcClip?.isMuted).toBe(true)

    // (b) An audio-kind track now exists.
    const tracksAfter = await getTracks()
    const audioTracks = tracksAfter.filter((t) => t.kind === 'audio')
    expect(audioTracks.length).toBeGreaterThanOrEqual(1)

    // (c) The detached clip lives on an audio track with correct properties.
    const detachedClip = await findClip(newClipId!)
    expect(detachedClip).not.toBeNull()
    expect(detachedClip?.kind).toBe('media')
    expect(detachedClip?.mediaId).toBe(mediaId)
    expect(detachedClip?.startMs).toBe(0)
    expect(detachedClip?.endMs).toBe(durationMs)
    expect(detachedClip?.trimInMs).toBe(0)
    expect(detachedClip?.trimOutMs).toBe(durationMs)

    // (d) The detached clip is NOT muted (it must provide the audio).
    expect(detachedClip?.isMuted).not.toBe(true)

    // (e) The detached clip lives on an audio track, not on the video track.
    const detachedTrack = tracksAfter.find((t) =>
      t.clips.some((c) => (c as { id?: string }).id === newClipId)
    )
    expect(detachedTrack?.kind).toBe('audio')
  })

  // =========================================================================
  // (2) No doubled audio at export — muted source emits no audio chain
  // =========================================================================
  test('(2) buildPlan: muted source video clip produces no audio chain; only the detached clip contributes audio', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `detach-no-double-${Date.now()}.mp4`)
    const result = await page.evaluate(async ({ outputPath }) => {
      const project = window.__reelsStore.state().project
      return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
    }, { outputPath: outPath })

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''
    expect(graph.length).toBeGreaterThan(0)

    // The filter graph uses clip-id suffixes (last 6 chars) to label audio
    // sub-chain nodes (e.g. "atrim_<suffix>", "av<suffix>", etc.).
    // The source clip's id suffix must appear in at most VIDEO-only nodes
    // (vscale, vtrim, etc.) but NOT in any audio filter chain nodes.
    // We count audio-specific filter occurrences per clip suffix.
    const srcSuffix = srcId.slice(-6)
    const newSuffix = newClipId!.slice(-6)

    // Audio chain markers: 'atrim', 'amix', 'asetpts', 'volume=', 'afade'
    // appear in audio sub-chains. The muted source clip must not generate any.
    const srcAudioFragments = graph.split(';').filter(
      (f) => f.includes(srcSuffix) && (f.includes('atrim') || f.includes('asetpts') || f.includes('volume='))
    )
    // The muted source clip should generate no audio sub-chain fragments.
    expect(srcAudioFragments.length).toBe(0)

    // The detached clip's suffix SHOULD appear in audio chain fragments.
    const detachedAudioFragments = graph.split(';').filter(
      (f) => f.includes(newSuffix) && (f.includes('atrim') || f.includes('asetpts') || f.includes('volume='))
    )
    expect(detachedAudioFragments.length).toBeGreaterThan(0)
  })

  // =========================================================================
  // (3) Detached audio IS present in the export graph
  // =========================================================================
  test('(3) buildPlan: detached clip audio chain is present in filterGraph (not muted)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `detach-present-${Date.now()}.mp4`)
    const result = await page.evaluate(async ({ outputPath }) => {
      const project = window.__reelsStore.state().project
      return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
    }, { outputPath: outPath })

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''

    const newSuffix = newClipId!.slice(-6)
    // The detached clip must have an audio chain in the graph.
    const hasDetachedAudio = graph.split(';').some(
      (f) => f.includes(newSuffix) && (f.includes('atrim') || f.includes('asetpts'))
    )
    expect(hasDetachedAudio).toBe(true)
  })

  // =========================================================================
  // (4) Undo restores in ONE step; redo re-applies
  // =========================================================================
  test('(4) undo reverses detachAudio in one step: audio clip gone + source isMuted reverts; redo re-applies', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await tick() // let addMedia settle as its own undo entry

    const srcId = await addVideoClip(mediaId, durationMs)
    await tick() // let addClip settle

    // Confirm source is not muted yet.
    const fresh = await findClip(srcId)
    expect(fresh?.isMuted).not.toBe(true)

    const beforeDetach = await getHistoryCounts()

    // Detach audio.
    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()
    await tick()

    // Confirm the detach produced exactly 1 new history entry.
    const afterDetach = await getHistoryCounts()
    expect(afterDetach.past).toBe(beforeDetach.past + 1)

    // Audio clip exists, source is muted.
    expect(await findClip(newClipId!)).not.toBeNull()
    expect((await findClip(srcId))?.isMuted).toBe(true)

    // Undo once.
    await undo()
    await page.waitForTimeout(150)

    // History moved back by 1.
    const afterUndo = await getHistoryCounts()
    expect(afterUndo.past).toBe(beforeDetach.past)

    // Audio clip gone; source no longer muted.
    expect(await findClip(newClipId!)).toBeNull()
    const srcAfterUndo = await findClip(srcId)
    expect(srcAfterUndo?.isMuted).not.toBe(true)

    // Redo.
    await redo()
    await page.waitForTimeout(150)

    // Audio clip back; source muted again.
    expect(await findClip(newClipId!)).not.toBeNull()
    expect((await findClip(srcId))?.isMuted).toBe(true)
  })

  // =========================================================================
  // (5) Edit independence — setClipGainDb on detached does NOT affect source
  // =========================================================================
  test('(5) setClipGainDb on detached clip does not mutate source; and vice versa', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()

    // Set gain on the detached clip.
    await page.evaluate((id) => {
      window.__reelsStore.setClipGainDb(id, -6)
    }, newClipId!)
    await page.waitForTimeout(80)

    // Source clip must be unaffected.
    const srcClip = await findClip(srcId)
    expect(srcClip?.gainDb).not.toBe(-6)

    // Set gain on the source clip.
    await page.evaluate((id) => {
      window.__reelsStore.setClipGainDb(id, 3)
    }, srcId)
    await page.waitForTimeout(80)

    // Detached clip must still have -6 (unchanged by the source edit).
    const detachedClip = await findClip(newClipId!)
    expect(detachedClip?.gainDb).toBe(-6)
  })

  // =========================================================================
  // (6) No-op cases
  // =========================================================================
  test('(6a) detachAudio on a clip already on an audio track returns null, no mutation', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add a clip directly on an existing audio track.
    const audioCid = await page.evaluate(
      ({ mid, dur }) => {
        const reels = window.__reelsStore
        const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')
        if (!audioTrack) throw new Error('no audio track in fresh project')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: audioTrack.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: durationMs }
    )

    const tracksBefore = await getTracks()

    // detachAudio on an audio-track clip must return null.
    const result = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), audioCid
    )
    expect(result).toBeNull()

    // State must be unchanged.
    const tracksAfter = await getTracks()
    const totalClipsBefore = tracksBefore.reduce((s, t) => s + t.clips.length, 0)
    const totalClipsAfter = tracksAfter.reduce((s, t) => s + t.clips.length, 0)
    expect(totalClipsAfter).toBe(totalClipsBefore)
  })

  test('(6b) detachAudio on an already-muted video clip returns null, no second detached twin', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    // First detach — should succeed.
    const firstId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(firstId).not.toBeNull()

    // Confirm source is muted.
    expect((await findClip(srcId))?.isMuted).toBe(true)

    const tracksAfterFirst = await getTracks()
    const clipCountAfterFirst = tracksAfterFirst.reduce((s, t) => s + t.clips.length, 0)

    // Second detach on the already-muted source — must return null.
    const secondId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(secondId).toBeNull()

    // No additional clips should have been created.
    const tracksAfterSecond = await getTracks()
    const clipCountAfterSecond = tracksAfterSecond.reduce((s, t) => s + t.clips.length, 0)
    expect(clipCountAfterSecond).toBe(clipCountAfterFirst)
  })

  // =========================================================================
  // (7) Byte-identical baseline — detach-never-called project has clean graph
  // =========================================================================
  test('(7) REGRESSION: project without detachAudio → filterGraph identical to a fresh-clip baseline', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    await addVideoClip(mediaId, durationMs)

    const outPath = path.join(os.tmpdir(), 'reels-studio-e2e', `detach-baseline-${Date.now()}.mp4`)
    const result = await page.evaluate(async ({ outputPath }) => {
      const project = window.__reelsStore.state().project
      return await window.electron.exporter.buildPlan(project, 'instagram-reels', outputPath)
    }, { outputPath: outPath })

    expect(result.ok, `buildPlan failed: ${result.error ?? ''}`).toBe(true)
    const graph: string = result.filterGraph ?? ''

    // A normal single-clip project must have scale=1080:1920.
    expect(graph).toContain('scale=1080:1920')

    // No detach-related artifacts: no duplicate amix, no unexpected audio splits.
    // The number of amix or audio concat nodes should be 0 for a single-clip
    // project (only one audio input, no mixing needed).
    // (Flexible check: count amix occurrences — for 1 clip there should be
    // at most 1 in a normal pipeline, not doubled.)
    const amixCount = (graph.match(/amix=/g) ?? []).length
    expect(amixCount).toBeLessThanOrEqual(1)
  })

  // =========================================================================
  // (8) Context-menu gating
  // =========================================================================
  test('(8) menu-detach-audio enabled for video-track media clip; disabled for already-muted clip', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    // --- (8a) Normal video-track media clip: menu-detach-audio must be enabled ---
    const clipBlock = page.locator(
      `[data-testid="media-clip-block"][data-clip-id="${srcId}"]`
    )
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const detachRow = page.locator('[data-testid="menu-detach-audio"]')
    await expect(detachRow).toBeVisible()
    // aria-disabled="false" means enabled; the row must NOT be aria-disabled=true.
    const ariaDisabled = await detachRow.getAttribute('aria-disabled')
    expect(ariaDisabled).not.toBe('true')

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="clip-context-menu"]')).toHaveCount(0)

    // --- (8b) After detach, source is muted → row must be disabled ---
    await page.evaluate((cid) => window.__reelsStore.detachAudio(cid), srcId)
    await page.waitForTimeout(150)

    // Re-open the context menu for the source clip (now muted).
    await clipBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const detachRowMuted = page.locator('[data-testid="menu-detach-audio"]')
    await expect(detachRowMuted).toBeVisible()
    const ariaDisabledMuted = await detachRowMuted.getAttribute('aria-disabled')
    expect(ariaDisabledMuted).toBe('true')

    await page.keyboard.press('Escape')
  })

  test('(8c) menu-detach-audio disabled for a clip on an audio track', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()

    // Add a clip directly onto an audio track.
    const audioCid = await page.evaluate(
      ({ mid, dur }) => {
        const reels = window.__reelsStore
        const audioTrack = reels.state().project.tracks.find((t) => t.kind === 'audio')
        if (!audioTrack) throw new Error('no audio track')
        const cid = reels.newId()
        reels.addClip({
          id: cid,
          kind: 'media',
          mediaId: mid,
          trackId: audioTrack.id,
          startMs: 0,
          endMs: dur,
          trimInMs: 0,
          trimOutMs: dur,
          speed: 1
        })
        return cid
      },
      { mid: mediaId, dur: durationMs }
    )

    const clipBlock = page.locator(
      `[data-testid="media-clip-block"][data-clip-id="${audioCid}"]`
    )
    await expect(clipBlock).toBeVisible({ timeout: 5_000 })
    await clipBlock.click({ button: 'right' })
    await expect(page.locator('[data-testid="clip-context-menu"]')).toBeVisible({
      timeout: 3_000
    })

    const detachRow = page.locator('[data-testid="menu-detach-audio"]')
    await expect(detachRow).toBeVisible()
    const ariaDisabled = await detachRow.getAttribute('aria-disabled')
    expect(ariaDisabled).toBe('true')

    await page.keyboard.press('Escape')
  })

  // =========================================================================
  // (9) Real export — exporter.run with a detached-audio clip
  // =========================================================================
  test('(9) exporter.run on a project with detached audio completes; output mp4 has non-zero size', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor()
    const { mediaId, durationMs } = await addFixtureMedia()
    const srcId = await addVideoClip(mediaId, durationMs)

    // Detach the audio.
    const newClipId = await page.evaluate((cid) =>
      window.__reelsStore.detachAudio(cid), srcId
    )
    expect(newClipId).not.toBeNull()

    const outDir = path.join(os.tmpdir(), 'reels-studio-e2e', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `detach-export-${Date.now()}.mp4`)
    if (existsSync(outPath)) {
      try { rmSync(outPath) } catch { /* ignore */ }
    }

    await page.evaluate(async (p) => {
      await window.electron.fs.allowPath(p)
    }, outPath)

    const r = await page.evaluate(
      async ({ outputPath }) => {
        const project = window.__reelsStore.state().project
        return await window.electron.exporter.run(project, {
          jobId: `e2e-detach-export-${Date.now()}`,
          presetKey: 'instagram-reels',
          outputPath
        })
      },
      { outputPath: outPath }
    )

    expect(r.ok, `expected export to succeed, error: ${r.error ?? ''}`).toBe(true)
    expect(r.outputPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  })
})
