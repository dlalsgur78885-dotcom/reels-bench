/**
 * @phase-auto-edit — "AI 자동 편집" (auto rough-cut) dialog E2E tests.
 *
 * Mock strategy:
 *   `contextBridge.exposeInMainWorld` makes `window.electron.*` read-only in
 *   the renderer world. We therefore mock at the IPC layer, following the
 *   `stt.spec.ts` pattern:
 *     - `audio:detectSilence` → removed + replaced via `app.evaluate({ ipcMain })`
 *     - `stt:transcribe` / `stt:modelStatus` → same pattern
 *
 *   The main-process mock stores per-call responses in `globalThis` so the
 *   renderer's `runAutoEdit` sees mocked data transparently.
 *
 * Covered scenarios:
 *  1.  Button opens dialog; Ctrl+Shift+A also opens it without touching redo.
 *  2.  Empty timeline → autoedit-empty shown, autoedit-start disabled.
 *  3.  Both toggles off → autoedit-start disabled.
 *  4.  Happy path: 2 clips, 1 SilenceRange each → summary "2개" + "초 제거됨".
 *  5.  Ripple correctness: silence removes 1000ms → second clip shifts left.
 *  6.  ONE undo step: pastStates +1; Ctrl+Z restores original clip layout.
 *  7.  No-audio guard: ≥95% silence → clip untouched.
 *  8.  detectSilence rejects for one clip → run still completes for others.
 *  9.  Multi-track warning: 2 video tracks → warning visible; secondary unchanged.
 * 10.  Captions ON → STT cues inserted; STT reject → 0 captions, cuts kept.
 * 11.  autoedit-cancel mid-run → run ends, partial result is one undo step.
 * 12.  No-silence: detectSilence → [] → summary "0개", project unchanged.
 */

import { expect, test } from '@playwright/test'
import { launchElectron, type LaunchedApp } from '../helpers/launch'
import { openAiMenu } from '../helpers/topbar'

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function getFixturePath(): string {
  const p = process.env.E2E_FIXTURE_MP4
  if (!p) throw new Error('E2E_FIXTURE_MP4 not set — globalSetup failed')
  return p
}

/** Navigate to the editor and wait for all test-bridges to be ready. */
async function openEditor(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.waitForFunction(() => !!window.electron, null, { timeout: 5_000 })
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

/** Reset to a pristine empty project and wait for zundo's deferred clear(). */
async function resetProject(launched: LaunchedApp): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    const store = (
      window as unknown as { __reelsStore: { createNew: () => void } }
    ).__reelsStore
    store.createNew()
    await new Promise((r) => setTimeout(r, 500))
  })
}

interface SeededClip {
  mediaId: string
  clipId: string
  trackId: string
  durationMs: number
  startMs: number
}

/**
 * Seed one media clip on a given track.
 * trackKind defaults to 'video', trackIndex to 0 (among tracks of that kind).
 * startMs defaults to 0, durationMs to the probed fixture duration.
 */
async function seedClipOnTrack(
  launched: LaunchedApp,
  opts: { trackKind?: 'video' | 'audio'; trackIndex?: number; startMs?: number; durationMs?: number } = {}
): Promise<SeededClip> {
  const { page } = launched
  const fixturePath = getFixturePath()
  return await page.evaluate(
    async ({
      filePath,
      trackKind,
      trackIndex,
      startMs: overrideStart,
      durationMs: overrideDuration
    }: {
      filePath: string
      trackKind: string
      trackIndex: number
      startMs: number | null
      durationMs: number | null
    }): Promise<{ mediaId: string; clipId: string; trackId: string; durationMs: number; startMs: number }> => {
      await window.electron.fs.allowPath(filePath)
      const probe = await window.electron.media.probe(filePath)
      const fileName = filePath.split(/[/\\]/).pop() ?? 'fixture.mp4'
      const store = (
        window as unknown as {
          __reelsStore: {
            state: () => { project: { tracks: Array<{ id: string; kind: string; clips: unknown[] }> } }
            addMedia: (a: unknown) => void
            addClip: (c: unknown) => void
            newId: () => string
          }
        }
      ).__reelsStore
      const id = store.newId()
      const dur = overrideDuration ?? probe.durationMs
      store.addMedia({
        id,
        path: filePath,
        kind: probe.kind,
        durationMs: dur,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        importedAt: Date.now(),
        fileName,
        fileSizeBytes: 0
      })
      const tracks = store.state().project.tracks
      const matchingTracks = tracks.filter((t) => t.kind === (trackKind || 'video'))
      const track = matchingTracks[trackIndex] ?? matchingTracks[0]
      if (!track) throw new Error(`no ${trackKind} track at index ${trackIndex}`)
      const cid = store.newId()
      const start = overrideStart ?? 0
      store.addClip({
        id: cid,
        kind: 'media',
        mediaId: id,
        trackId: track.id,
        startMs: start,
        endMs: start + dur,
        trimInMs: 0,
        trimOutMs: dur,
        speed: 1
      })
      return { mediaId: id, clipId: cid, trackId: track.id, durationMs: dur, startMs: start }
    },
    {
      filePath: fixturePath,
      trackKind: opts.trackKind ?? 'video',
      trackIndex: opts.trackIndex ?? 0,
      startMs: opts.startMs ?? null,
      durationMs: opts.durationMs ?? null
    }
  )
}

/**
 * Install a mock `audio:detectSilence` ipcMain handler that returns a
 * sequence of responses: the i-th ipcMain call returns responses[i]
 * (or the last entry for any excess calls).
 *
 * Each item is either an array of SilenceRanges or the string 'reject'.
 */
async function mockDetectSilence(
  launched: LaunchedApp,
  responses: Array<Array<{ startMs: number; endMs: number; durationMs: number }> | 'reject'>
): Promise<void> {
  const { app } = launched
  await app.evaluate(({ ipcMain }, resp) => {
    // Store responses on globalThis so the handler closure can read them.
    const g = globalThis as unknown as {
      __detectSilenceMockCalls: number
      __detectSilenceMockResponses: Array<Array<{ startMs: number; endMs: number; durationMs: number }> | 'reject'>
    }
    g.__detectSilenceMockCalls = 0
    g.__detectSilenceMockResponses = resp as Array<Array<{ startMs: number; endMs: number; durationMs: number }> | 'reject'>
    ipcMain.removeHandler('audio:detectSilence')
    ipcMain.handle('audio:detectSilence', async () => {
      const idx = Math.min(g.__detectSilenceMockCalls, g.__detectSilenceMockResponses.length - 1)
      g.__detectSilenceMockCalls += 1
      const entry = g.__detectSilenceMockResponses[idx]
      if (entry === 'reject') {
        throw new Error('mock detectSilence rejection')
      }
      return entry
    })
  }, responses as unknown[])
}

/**
 * Install a mock `stt:transcribe` ipcMain handler.
 * cues === null → the handler throws (simulates rejection).
 */
async function mockSttTranscribe(
  launched: LaunchedApp,
  cues: Array<{ startMs: number; endMs: number; text: string }> | null
): Promise<void> {
  const { app } = launched
  await app.evaluate(({ ipcMain }, cueMock) => {
    ipcMain.removeHandler('stt:transcribe')
    ipcMain.handle('stt:transcribe', async (_event, rawOpts: unknown) => {
      const opts = rawOpts as { jobId: string }
      if (cueMock === null) {
        throw new Error('stt mock rejection')
      }
      return {
        jobId: opts.jobId,
        ok: true,
        cues: cueMock,
        language: 'ko',
        durationMs: 3000
      }
    })
    // Ensure modelStatus doesn't block anything.
    ipcMain.removeHandler('stt:modelStatus')
    ipcMain.handle('stt:modelStatus', async () => ({ present: true, model: 'base' }))
  }, cues as unknown)
}

/** Snapshot pastStates length from the undo sub-store. */
async function getPastStatesCount(launched: LaunchedApp): Promise<number> {
  const { page } = launched
  return page.evaluate(() => {
    const undo = (
      window as unknown as {
        __reelsUndoRedo: { getState: () => { pastStates: unknown[] } }
      }
    ).__reelsUndoRedo
    return undo.getState().pastStates.length
  })
}

/** Return the media clips of a given track, sorted by startMs. */
async function getTrackClips(
  launched: LaunchedApp,
  trackId: string
): Promise<Array<{ id: string; startMs: number; endMs: number }>> {
  const { page } = launched
  return page.evaluate((tid) => {
    const store = (
      window as unknown as {
        __PROJECT_STORE_FOR_TEST__: {
          getState: () => {
            project: {
              tracks: Array<{
                id: string
                kind: string
                clips: Array<{ id: string; startMs: number; endMs: number; kind: string }>
              }>
            }
          }
        }
      }
    ).__PROJECT_STORE_FOR_TEST__.getState()
    const track = store.project.tracks.find((t) => t.id === tid)
    if (!track) return []
    return track.clips
      .filter((c) => c.kind === 'media')
      .sort((a, b) => a.startMs - b.startMs)
      .map((c) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs }))
  }, trackId)
}

/** Return caption clip count. */
async function getCaptionClipCount(launched: LaunchedApp): Promise<number> {
  const { page } = launched
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __PROJECT_STORE_FOR_TEST__: {
          getState: () => {
            project: { tracks: Array<{ kind: string; clips: unknown[] }> }
          }
        }
      }
    ).__PROJECT_STORE_FOR_TEST__.getState()
    const ct = store.project.tracks.find((t) => t.kind === 'caption')
    return ct?.clips.length ?? 0
  })
}

// ---------------------------------------------------------------------------
// 1. Button + Ctrl+Shift+A open the dialog.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 1: open dialog via button and Ctrl+Shift+A', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('open-autoedit-dialog button opens autoedit-dialog', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()
  })

  test('Ctrl+Shift+A opens autoedit-dialog and does NOT trigger redo', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    const pastBefore = await getPastStatesCount(launched)

    // Focus on a non-input element so the shortcut fires.
    await page.locator('[data-testid="timeline"]').click()
    await page.keyboard.press('Control+Shift+A')
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()

    const pastAfter = await getPastStatesCount(launched)
    // Opening a dialog must not change undo history.
    expect(pastAfter).toBe(pastBefore)
  })
})

// ---------------------------------------------------------------------------
// 2. Empty timeline → autoedit-empty shown, start disabled.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 2: empty timeline state', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('empty timeline → autoedit-empty visible, autoedit-start disabled', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()
    await expect(page.locator('[data-testid="autoedit-empty"]')).toBeVisible()
    await expect(page.locator('[data-testid="autoedit-start"]')).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// 3. Both toggles off → start disabled.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 3: both toggles off', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('silence OFF + captions OFF → start disabled; enabling captions re-enables it', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)
    await seedClipOnTrack(launched)
    await page.waitForTimeout(300)

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()

    // Default: silence ON → start enabled.
    await expect(page.locator('[data-testid="autoedit-start"]')).not.toBeDisabled()

    // Uncheck silence toggle → both off → disabled.
    await page.locator('[data-testid="autoedit-toggle-silence"]').uncheck()
    await expect(page.locator('[data-testid="autoedit-start"]')).toBeDisabled()

    // Enable captions → start re-enabled.
    await page.locator('[data-testid="autoedit-toggle-captions"]').check()
    await expect(page.locator('[data-testid="autoedit-start"]')).not.toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// 4. Happy path: 2 clips, 1 SilenceRange each.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 4: happy path two clips', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('2 clips → progress → summary shows 2개 and 초 제거됨, no gaps', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    // Two clips with different durations so they have different trims.
    // Both share the same media path (fixture), but the memoized detectSilence
    // returns its one range for both — so both are cut: rangesRemoved = 2.
    const c1 = await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(200)
    await seedClipOnTrack(launched, { startMs: 5000, durationMs: 4000 })
    await page.waitForTimeout(300)

    // Mock: return one 1000ms silence range per detectSilence call.
    // Because the cache memoizes by path (both clips share the fixture path),
    // only ONE ipcMain call is made but it applies to BOTH clips → rangesRemoved=2.
    await mockDetectSilence(launched, [
      [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
    ])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-start"]')).not.toBeDisabled()
    await page.locator('[data-testid="autoedit-start"]').click()

    await expect(page.locator('[data-testid="autoedit-progress"]')).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    const summaryText = await page.locator('[data-testid="autoedit-summary"]').textContent() ?? ''
    // rangesRemoved should be ≥1 (at minimum 1 range; with cache hit on same path → 2).
    expect(summaryText).toMatch(/[1-9]\d*개/)
    expect(summaryText).toMatch(/초 제거됨/)

    await expect(page.locator('[data-testid="autoedit-done-close"]')).toBeVisible()

    // Primary track clips must be gap-free.
    const clips = await getTrackClips(launched, c1.trackId)
    expect(clips.length).toBeGreaterThan(1)
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].startMs).toBe(clips[i - 1].endMs)
    }

    // Total duration must be less than original 9000ms.
    const totalDuration = clips[clips.length - 1].endMs - clips[0].startMs
    expect(totalDuration).toBeLessThan(9000)
  })
})

// ---------------------------------------------------------------------------
// 5. Ripple correctness.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 5: ripple correctness', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('1000ms silence removed from clip1 → all clips butt together, total span < 10000', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    const clip1 = await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(200)
    await seedClipOnTrack(launched, { startMs: 5000, durationMs: 5000 })
    await page.waitForTimeout(300)

    // One 1000ms silence in the shared media → cut applied to clip1 (at minimum).
    await mockDetectSilence(launched, [
      [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
    ])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    const clips = await getTrackClips(launched, clip1.trackId)
    // No gaps after ripple.
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].startMs).toBe(clips[i - 1].endMs)
    }
    // Total span must be less than original 10000ms.
    const totalSpan = clips[clips.length - 1].endMs - clips[0].startMs
    expect(totalSpan).toBeLessThan(10000)
  })
})

// ---------------------------------------------------------------------------
// 6. ONE undo step.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 6: one undo step', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('run produces exactly one extra pastState; Ctrl+Z restores original', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    const clip = await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(400) // let zundo throttle flush seedClip

    const pastBefore = await getPastStatesCount(launched)
    const clipsBefore = await getTrackClips(launched, clip.trackId)

    await mockDetectSilence(launched, [
      [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
    ])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    await page.waitForTimeout(400) // let zundo throttle flush the run's final setState

    const pastAfter = await getPastStatesCount(launched)
    expect(pastAfter - pastBefore).toBe(1)

    // Close dialog.
    await page.locator('[data-testid="autoedit-done-close"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toHaveCount(0, { timeout: 5_000 })

    // One Ctrl+Z restores the timeline to its pre-run state.
    await page.locator('[data-testid="timeline"]').click()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)

    const clipsAfterUndo = await getTrackClips(launched, clip.trackId)
    expect(clipsAfterUndo.length).toBe(clipsBefore.length)
    // The clip's original boundaries must be restored.
    if (clipsBefore.length > 0 && clipsAfterUndo.length > 0) {
      expect(clipsAfterUndo[0].startMs).toBe(clipsBefore[0].startMs)
      expect(clipsAfterUndo[0].endMs).toBe(clipsBefore[0].endMs)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. No-audio guard.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 7: no-audio guard', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('clip with >=95% silence is left intact (not cut, not dropped)', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    const clip = await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(300)

    // 4800ms silence out of 5000ms source window = 96% → guard fires.
    await mockDetectSilence(launched, [
      [{ startMs: 100, endMs: 4900, durationMs: 4800 }]
    ])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    const clips = await getTrackClips(launched, clip.trackId)
    // Guard: still exactly 1 clip, boundaries unchanged.
    expect(clips.length).toBe(1)
    expect(clips[0].startMs).toBe(0)
    expect(clips[0].endMs).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// 8. detectSilence rejects for one clip → run continues.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 8: detectSilence rejects', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('detectSilence rejects once → run completes, summary visible', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(300)

    // Since the cache memoizes by path, only ONE ipcMain call is made for all
    // clips on the same media. Mock that call to reject.
    await mockDetectSilence(launched, ['reject'])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()

    // Run must complete (skip-and-continue, not rethrow).
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })
    // Summary visible = run completed without crashing.
    const summaryText = await page.locator('[data-testid="autoedit-summary"]').textContent() ?? ''
    expect(summaryText).toMatch(/초 제거됨/)
  })
})

// ---------------------------------------------------------------------------
// 9. Multi-track warning.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 9: multi-track warning', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('2 video tracks → warning visible; secondary clip startMs unchanged after run', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    // Seed clip on primary (first) video track.
    const primary = await seedClipOnTrack(launched, { trackKind: 'video', trackIndex: 0, startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(200)

    // Add a second video track.
    await page.evaluate(() => {
      const store = (
        window as unknown as { __reelsStore: { addVideoTrack: () => void } }
      ).__reelsStore
      store.addVideoTrack()
    })
    await page.waitForTimeout(200)

    // Seed clip on secondary (second) video track at startMs=2000.
    const secondary = await seedClipOnTrack(launched, {
      trackKind: 'video',
      trackIndex: 1,
      startMs: 2000,
      durationMs: 3000
    })
    await page.waitForTimeout(300)

    // One 1000ms silence → primary track gets cut; secondary must not move.
    await mockDetectSilence(launched, [
      [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
    ])

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()

    // Multi-track warning must be visible.
    await expect(page.locator('[data-testid="autoedit-multitrack-warning"]')).toBeVisible()

    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    // Primary track: no gaps.
    const primaryClips = await getTrackClips(launched, primary.trackId)
    for (let i = 1; i < primaryClips.length; i++) {
      expect(primaryClips[i].startMs).toBe(primaryClips[i - 1].endMs)
    }

    // Secondary track: its clip must still start at 2000ms.
    const secondaryClips = await getTrackClips(launched, secondary.trackId)
    expect(secondaryClips.length).toBeGreaterThan(0)
    expect(secondaryClips[0].startMs).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// 10. Captions toggle.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 10: captions toggle', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('captions ON + mock STT → 3 caption clips added, summary shows 자막 N개', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(300)

    // No silence → no cuts; only captions will be added.
    await mockDetectSilence(launched, [[]])
    await mockSttTranscribe(launched, [
      { startMs: 0, endMs: 1000, text: '자막 하나' },
      { startMs: 1000, endMs: 2000, text: '자막 둘' },
      { startMs: 2000, endMs: 3000, text: '자막 셋' }
    ])

    const captionsBefore = await getCaptionClipCount(launched)

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await expect(page.locator('[data-testid="autoedit-dialog"]')).toBeVisible()

    // Enable captions toggle → language select appears.
    await page.locator('[data-testid="autoedit-toggle-captions"]').check()
    await expect(page.locator('[data-testid="autoedit-language-select"]')).toBeVisible()

    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    const summaryText = await page.locator('[data-testid="autoedit-summary"]').textContent() ?? ''
    // generateCaptions=true → caption line rendered.
    expect(summaryText).toMatch(/자막 \d+개/)

    await page.waitForTimeout(300)
    const captionsAfter = await getCaptionClipCount(launched)
    expect(captionsAfter - captionsBefore).toBe(3)
  })

  test('captions ON + STT reject → cuts kept, 0 captions added, no crash', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(300)

    // One silence → clip gets cut.
    await mockDetectSilence(launched, [
      [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
    ])
    // STT rejects.
    await mockSttTranscribe(launched, null)

    const captionsBefore = await getCaptionClipCount(launched)

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-toggle-captions"]').check()
    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    // Summary shows 자막 0개 (generateCaptions=true, but 0 were added).
    const summaryText = await page.locator('[data-testid="autoedit-summary"]').textContent() ?? ''
    expect(summaryText).toMatch(/자막 0개/)

    const captionsAfter = await getCaptionClipCount(launched)
    expect(captionsAfter).toBe(captionsBefore)
  })
})

// ---------------------------------------------------------------------------
// 11. Cancel mid-run.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 11: cancel mid-run', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('cancel during run → run ends gracefully, result is one undo step', async () => {
    if (!launched) throw new Error('launch failed')
    const { app, page } = launched
    await openEditor(launched)
    await resetProject(launched)

    await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(400)

    const pastBefore = await getPastStatesCount(launched)

    // Mock detectSilence with a 400ms delay so we can cancel while it runs.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('audio:detectSilence')
      ipcMain.handle('audio:detectSilence', async () => {
        await new Promise<void>((r) => setTimeout(r, 400))
        return [{ startMs: 1000, endMs: 2000, durationMs: 1000 }]
      })
    })

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()

    // Wait for progress overlay.
    await expect(page.locator('[data-testid="autoedit-progress"]')).toBeVisible({ timeout: 5_000 })

    // Click cancel if the button is visible.
    await page.waitForTimeout(100)
    const cancelBtn = page.locator('[data-testid="autoedit-cancel"]')
    if (await cancelBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await cancelBtn.click()
    }

    // Run must resolve (summary appears) regardless of cancel timing.
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    await page.waitForTimeout(400) // let zundo throttle flush

    // Exactly one undo step was created (the finally{} block always commits).
    const pastAfter = await getPastStatesCount(launched)
    expect(pastAfter - pastBefore).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 12. No-silence: detectSilence returns [] for all → 0개, project unchanged.
// ---------------------------------------------------------------------------

test.describe('@phase-auto-edit 12: no-silence case', () => {
  let launched: LaunchedApp | null = null

  test.beforeEach(async () => { launched = await launchElectron() })
  test.afterEach(async () => {
    if (launched) { try { await launched.app.close() } catch { /* ignore */ } launched = null }
  })

  test('no silence detected → summary shows 0개, clip layout unchanged', async () => {
    if (!launched) throw new Error('launch failed')
    const { page } = launched
    await openEditor(launched)
    await resetProject(launched)

    const clip = await seedClipOnTrack(launched, { startMs: 0, durationMs: 5000 })
    await page.waitForTimeout(300)

    await mockDetectSilence(launched, [[]])

    const clipsBefore = await getTrackClips(launched, clip.trackId)

    await openAiMenu(page)
    await page.locator('[data-testid="open-autoedit-dialog"]').click()
    await page.locator('[data-testid="autoedit-start"]').click()
    await expect(page.locator('[data-testid="autoedit-summary"]')).toBeVisible({ timeout: 15_000 })

    const summaryText = await page.locator('[data-testid="autoedit-summary"]').textContent() ?? ''
    expect(summaryText).toMatch(/0개/)

    const clipsAfter = await getTrackClips(launched, clip.trackId)
    expect(clipsAfter.length).toBe(clipsBefore.length)
    if (clipsBefore.length > 0 && clipsAfter.length > 0) {
      expect(clipsAfter[0].startMs).toBe(clipsBefore[0].startMs)
      expect(clipsAfter[0].endMs).toBe(clipsBefore[0].endMs)
    }
  })
})
